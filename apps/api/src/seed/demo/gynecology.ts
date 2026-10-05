import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { calls, conversations, journeys, marketingCampaigns, messages, tasks, timelineEvents } from "../../db/schema.js";
import { recordTouchpoint } from "../../domain/acquisition/attribution.service.js";
import { installDepartmentTemplate } from "../../domain/specialty/department.service.js";
import { GYNECOLOGY_TREATMENTS } from "../../domain/specialty/gynecology.templates.js";
import { assertJourneyConfigsConsistent } from "./consistency.js";
import {
  createDemoBranches,
  createDemoConnectors,
  createDemoPatients,
  createDemoTenant,
  createDemoUsers,
  createLeadsInOrder,
  daysFromNow,
  journeyIdForPatient,
  minutesAgo,
  seedConversations,
  seedJourneys,
  type ConversationConfig,
  type DemoContext,
  type DemoJourneyConfig,
  type LeadInput,
} from "./shared.js";

// Inbox demo data: covers every channel and every ownership state at least
// once, with two HUMAN_REQUIRED conversations so the triage queue reads as
// a real backlog rather than a single example.
const CONVERSATION_CONFIGS: ConversationConfig[] = [
  {
    patientIdx: 0, channel: "WHATSAPP", ownershipState: "HUMAN_REQUIRED", assignedTo: null,
    messages: [
      { sender: "ai", body: "Hi Priya! Just checking in — have you and your partner decided on IVF Cycle 1 timing yet?", minutesAgoSent: 90 },
      { sender: "patient", body: "We're still deciding, but I have a question about the payment plan the AI couldn't answer.", minutesAgoSent: 20, unread: true },
    ],
  },
  {
    patientIdx: 12, channel: "WHATSAPP", ownershipState: "HUMAN_REQUIRED", assignedTo: null,
    messages: [
      { sender: "ai", body: "Hope your recovery from IVF Cycle 1 is going well. Any discomfort to report?", minutesAgoSent: 200 },
      { sender: "patient", body: "I've had some bleeding since yesterday — is that normal? I'd like to speak to someone.", minutesAgoSent: 15, unread: true },
    ],
  },
  {
    patientIdx: 1, channel: "WHATSAPP", ownershipState: "AI_ACTIVE", assignedTo: null,
    messages: [
      { sender: "patient", body: "What documents do I need to bring for my consultation?", minutesAgoSent: 60 },
      { sender: "ai", body: "Please bring a valid photo ID and any previous test reports you have.", minutesAgoSent: 58 },
    ],
  },
  {
    patientIdx: 6, channel: "CALL", ownershipState: "HUMAN_ASSIGNED", assignedTo: "coordinator",
    messages: [{ sender: "system", body: "Missed call from patient — flagged for follow-up.", minutesAgoSent: 300 }],
  },
  {
    patientIdx: 8, channel: "SMS", ownershipState: "HUMAN_ACTIVE", assignedTo: "coordinator",
    messages: [
      { sender: "patient", body: "Can we move the IVF review call to Friday?", minutesAgoSent: 45 },
      { sender: "staff", body: "Yes, I've noted Friday — I'll confirm the exact time shortly.", minutesAgoSent: 30 },
    ],
  },
  {
    patientIdx: 7, channel: "EMAIL", ownershipState: "AI_RESUME_PENDING", assignedTo: "frontDesk",
    messages: [
      { sender: "patient", body: "Thank you for clarifying the billing breakdown for my IUI cycle.", minutesAgoSent: 500 },
      { sender: "staff", body: "You're welcome! Handing you back to our assistant for anything else.", minutesAgoSent: 480 },
    ],
  },
  {
    patientIdx: 10, channel: "INTERNAL", ownershipState: "CLOSED", assignedTo: "coordinator",
    messages: [{ sender: "staff", body: "Payment for IVF Cycle 1 confirmed and reconciled — closing this thread.", minutesAgoSent: 1440 }],
  },
];

// The deliberate marketing story this seed tells:
//   - "Meta – Fertility Awareness": cheap enquiries, poor treatment conversion (1/8)
//   - "Google – IVF Search": pricier enquiries, high treatment conversion (3/5) and revenue
//   - "Website – Landing Page": strong appointment rate, but no-show leakage (2/5)
//   - Referral / walk-in: no campaign spend, nothing to protect (contrast for Spend At Risk)
export const GYNECOLOGY_PATIENT_NAMES = [
  "Priya Sharma", "Vikram Kumar", "Sneha Reddy", "Aditya Verma", "Lakshmi Nair",
  "Rahul Gupta", "Ishita Singh", "Karthik Pillai", "Divya Menon", "Arjun Patel",
  "Neha Joshi", "Suresh Iyer", "Pooja Agarwal", "Manoj Krishnan", "Ananya Desai",
  "Ravi Shankar", "Meenakshi Rao", "Siddharth Bose", "Tara Chawla", "Vishal Malhotra",
];

export const JOURNEY_CONFIGS: DemoJourneyConfig[] = [
  // --- Meta group (8 journeys, poor conversion) ---
  {
    patientIdx: 0, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "consulted",
    contactedOffsetDays: -5, createdOffsetDays: -6,
    appt: { status: "completed", offsetDays: -2, doctor: "meera" },
    outcome: { value: "DECISION_PENDING", notes: "Discussing IVF cycle timing with partner" },
    treatment: { definitionKey: "IVF_CYCLE_1", status: "DECISION_PENDING", estimatedValue: 300_00 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: -1 },
  },
  {
    patientIdx: 1, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1,
    task: { reason: "high_intent_uncontacted", dueOffsetDays: -1 },
  },
  {
    patientIdx: 2, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "contacted",
    contactedOffsetDays: -1, createdOffsetDays: -2,
    task: { reason: "overdue_callback", dueOffsetDays: -1 },
  },
  {
    patientIdx: 3, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "scheduled", offsetDays: 1, doctor: "arjun" },
  },
  {
    patientIdx: 4, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "consulted",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    appt: { status: "completed", offsetDays: -1, doctor: "meera" },
    outcome: { value: "NO_TREATMENT_REQUIRED" },
  },
  {
    patientIdx: 5, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "consulted",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "completed", offsetDays: -3, doctor: "arjun" },
    outcome: { value: "FOLLOW_UP_REQUIRED" },
    task: { reason: "missed_follow_up", dueOffsetDays: -2 },
  },
  {
    patientIdx: 6, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "treatment_advised",
    contactedOffsetDays: -6, createdOffsetDays: -7,
    appt: { status: "completed", offsetDays: -3, doctor: "meera" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IUI_CYCLE", status: "ADVISED", estimatedValue: 25_000 },
  },
  {
    patientIdx: 7, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "meta", campaignKey: "meta", stage: "completed",
    contactedOffsetDays: -8, createdOffsetDays: -9,
    appt: { status: "completed", offsetDays: -6, doctor: "arjun" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IUI_CYCLE", status: "COMPLETED", estimatedValue: 22_000 },
    revenueAmount: 22_000, revenueOffsetDays: -1,
  },

  // --- Google group (5 journeys, expensive but high conversion) ---
  {
    patientIdx: 8, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "google", campaignKey: "google", stage: "treatment_advised",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "completed", offsetDays: -2, doctor: "meera" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IVF_CYCLE_1", status: "DECISION_PENDING", estimatedValue: 60_000 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: -3 },
  },
  {
    patientIdx: 9, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "google", campaignKey: "google", stage: "scheduled",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    appt: { status: "completed", offsetDays: -3, doctor: "arjun" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IVF_CYCLE_1", status: "SCHEDULED", estimatedValue: 70_000, decisionOffsetDays: -1, plannedOffsetDays: 6 },
  },
  {
    patientIdx: 10, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "google", campaignKey: "google", stage: "completed",
    contactedOffsetDays: -11, createdOffsetDays: -12,
    appt: { status: "completed", offsetDays: -10, doctor: "meera" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IVF_CYCLE_1", status: "COMPLETED", estimatedValue: 95_000 },
    revenueAmount: 95_000, revenueOffsetDays: -5,
  },
  {
    patientIdx: 11, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "google", campaignKey: "google", stage: "completed",
    contactedOffsetDays: -13, createdOffsetDays: -14,
    appt: { status: "completed", offsetDays: -12, doctor: "arjun" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IVF_CYCLE_2", status: "COMPLETED", estimatedValue: 110_000 },
    revenueAmount: 110_000, revenueOffsetDays: -6,
  },
  {
    patientIdx: 12, journeyType: "Fertility", specialtyKey: "FERTILITY", source: "google", campaignKey: "google", stage: "completed",
    contactedOffsetDays: -9, createdOffsetDays: -10,
    appt: { status: "completed", offsetDays: -8, doctor: "meera" },
    outcome: { value: "TREATMENT_ADVISED" },
    treatment: { definitionKey: "IVF_CYCLE_1", status: "COMPLETED", estimatedValue: 88_000 },
    revenueAmount: 88_000, revenueOffsetDays: -4,
  },

  // --- Website group (5 journeys, strong appointment rate, no-show leakage) ---
  {
    patientIdx: 13, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "website", campaignKey: "website", stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "no_show", offsetDays: -1, doctor: "meera" },
    task: { reason: "no_show", dueOffsetDays: -1 },
  },
  {
    patientIdx: 14, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "website", campaignKey: "website", stage: "booked",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "no_show", offsetDays: -2, doctor: "arjun" },
    task: { reason: "no_show", dueOffsetDays: -2 },
  },
  {
    patientIdx: 15, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "website", campaignKey: "website", stage: "consulted",
    contactedOffsetDays: -3, createdOffsetDays: -4,
    appt: { status: "completed", offsetDays: -2, doctor: "meera" },
    outcome: { value: "CONSULTED" },
  },
  {
    patientIdx: 16, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "website", campaignKey: "website", stage: "consulted",
    contactedOffsetDays: -5, createdOffsetDays: -6,
    appt: { status: "completed", offsetDays: -4, doctor: "arjun" },
    outcome: { value: "FOLLOW_UP_REQUIRED" },
    task: { reason: "missed_follow_up", dueOffsetDays: -3 },
  },
  {
    patientIdx: 17, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "website", campaignKey: "website", stage: "consulted",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    appt: { status: "completed", offsetDays: -1, doctor: "meera" },
    outcome: { value: "NO_TREATMENT_REQUIRED" },
  },

  // --- No campaign (referral / walk-in): nothing to protect ---
  {
    patientIdx: 18, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "referral", campaignKey: null, stage: "lost",
    contactedOffsetDays: -10, createdOffsetDays: -14,
  },
  {
    patientIdx: 19, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "walk_in", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1,
    task: { reason: "high_intent_uncontacted", dueOffsetDays: -1 },
  },

  // Priya Sharma's second, concurrent journey — proves Patient != Journey.
  {
    patientIdx: 0, journeyType: "Pregnancy Care", specialtyKey: "GYNECOLOGY", source: "referral", campaignKey: null, stage: "consulted",
    contactedOffsetDays: -3, createdOffsetDays: -10,
    appt: { status: "completed", offsetDays: -3, doctor: "arjun" },
    outcome: { value: "CONSULTED" },
  },

  // A second, concurrent journey for Vikram Kumar with today's consultation already
  // completed but no outcome recorded yet — lets the doctor outcome workflow be
  // exercised live in the browser against today's date, not just historical data.
  {
    patientIdx: 1, journeyType: "Gynecology Consultation", specialtyKey: "GYNECOLOGY", source: "walk_in", campaignKey: null, stage: "attended",
    contactedOffsetDays: 0, createdOffsetDays: 0,
    appt: { status: "completed", offsetDays: 0, doctor: "meera" },
  },
];

export async function seedGynecologyTenant(passwordHash: string) {
  const tenant = await createDemoTenant("PulseOS Gynecology Demo", "BETA_V2_GROWTH", { loginSlug: "gyn-demo", login: { shortName: "Gynecology Demo", badgeLabel: "Beta V2" } });
  // The same install a hospital admin runs from Settings: department, services, fields, catalogue, lead sources.
  await installDepartmentTemplate(db, tenant.id, "gynecology");

  const branchByKey = await createDemoBranches(tenant.id, [
    { name: "Koramangala Centre", city: "Bengaluru" },
    { name: "Whitefield Centre", city: "Bengaluru" },
  ]);
  const { a: branchA, b: branchB } = branchByKey;

  // "Fertility Line" is seeded inactive (configured, pending activation) so
  // Main Line stays the sole ACTIVE Runo endpoint — the seeded call below
  // then resolves deterministically, mirroring getSoleActiveEndpointForConnector.
  const { whatsappConnector, runoConnector, endpoints } = await createDemoConnectors(tenant.id, branchByKey, {
    // Long-standing fixture identifiers — the webhook integration tests sign with these.
    identifiers: {
      wabaId: "FIXTURE_WABA_ID", whatsappAccessToken: "FIXTURE_TEST_ACCESS_TOKEN", appSecret: "FIXTURE_TEST_APP_SECRET",
      verifyToken: "pulseos-fixture-verify-token", runoSecret: "pulseos-fixture-runo-secret", gbpLocationId: "locations/FIXTURE_LOCATION_ID",
      gbpAccessToken: "FIXTURE_GBP_ACCESS_TOKEN", googleKey: "pulseos-fixture-google-key", metaPageAccessToken: "FIXTURE_PAGE_ACCESS_TOKEN",
      intakeToken: "pulseos-fixture-intake-token",
    },
    phoneNumberId: "FIXTURE_PHONE_NUMBER_ID",
    whatsappNumber: "+91 98450 12345",
    whatsappLabel: "WhatsApp — Main Line",
    formIds: ["landing-fertility-v2"],
    metaPageId: "FIXTURE_PAGE_ID",
    phoneLines: [
      { key: "main", number: "+91 80 4012 3456", providerRef: "MAIN-LINE", label: "Main Line", isActive: true, branch: "a" },
      { key: "fertility", number: "+91 80 4012 3457", providerRef: "FERTILITY-LINE", label: "Fertility Line", isActive: false, branch: null },
    ],
  });
  const mainLineEndpoint = endpoints.main;
  const whatsappEndpoint = endpoints.whatsapp;

  const staff = await createDemoUsers("gynecology", tenant.id, passwordHash, branchByKey, [
    { slug: "superadmin", name: "Anand Iyer", role: "SUPER_ADMIN", branch: "a" },
    { slug: "admin", name: "Ananya Rao", role: "HOSPITAL_ADMIN", branch: "a" },
    { slug: "doctor", name: "Dr. Meera Iyer", role: "DOCTOR", branch: "a" },
    { slug: "doctor2", name: "Dr. Arjun Nair", role: "DOCTOR", branch: "b" },
    { slug: "frontdesk", name: "Kavya Menon", role: "FRONT_DESK", branch: "a" },
    { slug: "coordinator", name: "Rohan Das", role: "PATIENT_COORDINATOR", branch: "a" },
  ]);
  const { admin, coordinator, frontdesk: frontDesk } = staff;
  const doctorMeera = staff.doctor;
  const doctorArjun = staff.doctor2;

  const [metaCampaign, googleCampaign, websiteCampaign, metaAntenatalCampaign] = await db
    .insert(marketingCampaigns)
    .values([
      { tenantId: tenant.id, source: "meta", name: "Meta – Fertility Awareness", spendAmount: 48_000, startDate: daysFromNow(-30), status: "active" },
      { tenantId: tenant.id, source: "google", name: "Google – IVF Search", spendAmount: 75_000, startDate: daysFromNow(-30), status: "active" },
      { tenantId: tenant.id, source: "website", name: "Website – Landing Page", spendAmount: 15_000, startDate: daysFromNow(-30), status: "active" },
      // Deliberately weak performer: real spend, real leads, poor follow-through —
      // demonstrates the Campaigns page's budget-leakage insight with genuine data.
      { tenantId: tenant.id, source: "meta", name: "Meta – Antenatal Care Awareness", spendAmount: 18_000, startDate: daysFromNow(-20), status: "active" },
    ])
    .returning();
  const campaigns = { meta: metaCampaign, google: googleCampaign, website: websiteCampaign, metaAntenatal: metaAntenatalCampaign };

  assertJourneyConfigsConsistent("gynecology", JOURNEY_CONFIGS, GYNECOLOGY_PATIENT_NAMES, new Set(GYNECOLOGY_TREATMENTS.map((t) => t.key)));
  const patientNames = GYNECOLOGY_PATIENT_NAMES;
  const patientRows = await createDemoPatients(tenant.id, branchByKey, patientNames, 800_000_000, ["Kannada", "Hindi", "English"]);

  const ctx: DemoContext = {
    tenantId: tenant.id, branches: branchByKey, admin, coordinator, frontDesk,
    doctors: { meera: doctorMeera, arjun: doctorArjun }, campaigns, patients: patientRows,
    runoConnectorId: runoConnector.id, whatsappConnectorId: whatsappConnector.id, endpoints,
  };

  const { journeyIds, timelineRows } = await seedJourneys(ctx, JOURNEY_CONFIGS);

  // A few standalone tasks spanning today/upcoming/completed so every My Work view has real rows.
  const journeyOf = (patientIdx: number) => journeyIdForPatient(JOURNEY_CONFIGS, journeyIds, patientIdx);
  await db.insert(tasks).values([
    {
      tenantId: tenant.id, patientId: patientRows[2].id, journeyId: journeyOf(2),
      assignedTo: coordinator.id, reason: "manual_task", type: "APPOINTMENT_CONFIRMATION", priority: "normal",
      notes: "Confirm tomorrow's 11am slot with patient", status: "pending", dueAt: daysFromNow(0, 15), createdBy: admin.id,
    },
    {
      tenantId: tenant.id, patientId: patientRows[3].id, journeyId: journeyOf(3),
      assignedTo: frontDesk.id, reason: "manual_task", type: "RECALL", priority: "normal",
      status: "pending", dueAt: daysFromNow(4, 10), createdBy: admin.id,
    },
    {
      tenantId: tenant.id, patientId: patientRows[4].id, journeyId: journeyOf(4),
      assignedTo: coordinator.id, reason: "manual_task", type: "POST_CARE", priority: "normal",
      notes: "Post-op check-in call", status: "completed", dueAt: daysFromNow(-2, 10),
      completedAt: daysFromNow(-2, 14), completedBy: coordinator.id, createdBy: admin.id,
    },
  ]);

  // Conversation row for each CONVERSATION_CONFIGS entry, same index — the
  // omnichannel fixtures below update Vikram Kumar's existing WhatsApp
  // conversation (index 2) in place rather than inserting a second, dishonest
  // thread for a patient who only has one real WhatsApp wa_id.
  const conversationRows = await seedConversations(ctx, CONVERSATION_CONFIGS);

  // ---------------------------------------------------------------------
  // Omnichannel fixtures (Group T/V follow-up): calls + WhatsApp threads
  // shaped to match exactly what persistInboundCall() / processInbound-
  // WhatsAppMessage() would have produced through the real webhook path —
  // hand-inserted here (seed data, never a live provider event) rather than
  // invoked through those services, but honest about their resolution
  // outcomes rather than forcing a link the real logic wouldn't produce.
  // ---------------------------------------------------------------------

  // Sneha Reddy (idx 2) has exactly one active Journey ("Fertility", Meta,
  // stage "contacted") — the deterministic case for BOTH endpoint
  // resolution (Runo's sole active endpoint, Main Line) and WhatsApp
  // Journey-linking (single active Journey, auto-linked).
  const [snehaCall] = await db
    .insert(calls)
    .values({
      tenantId: tenant.id,
      connectorId: runoConnector.id,
      communicationEndpointId: mainLineEndpoint.id,
      patientId: patientRows[2].id,
      journeyId: journeyIds[2],
      externalCallId: "runo-fixture-call-001",
      direction: "inbound",
      phone: patientRows[2].phone,
      status: "completed",
      durationSeconds: 214,
      disposition: null,
      agentName: "Rohan Das",
      startedAt: minutesAgo(184),
      endedAt: minutesAgo(180),
      metadata: { seedFixture: true },
    })
    .returning();
  timelineRows.push({
    tenantId: tenant.id, patientId: patientRows[2].id, journeyId: journeyIds[2],
    actorType: "system", eventType: "call_logged", channel: "IVR_CALL", title: "Call completed · Rohan Das",
    occurredAt: minutesAgo(180), relatedEntityType: "call", relatedEntityId: snehaCall.id,
  });

  // Ishita Singh (idx 6) — a missed inbound call. status: "missed" mirrors
  // callStatusEnum exactly, and the task below matches createMissedCallTask()
  // in call-webhook.service.ts field for field (reason: "missed_follow_up",
  // type CALLBACK, priority high, assigned to the Journey's own owner).
  const [ishitaCall] = await db
    .insert(calls)
    .values({
      tenantId: tenant.id,
      connectorId: runoConnector.id,
      communicationEndpointId: mainLineEndpoint.id,
      patientId: patientRows[6].id,
      journeyId: journeyIds[6],
      externalCallId: "runo-fixture-call-002",
      direction: "inbound",
      phone: patientRows[6].phone,
      status: "missed",
      durationSeconds: 0,
      disposition: null,
      agentName: null,
      startedAt: minutesAgo(305),
      endedAt: minutesAgo(305),
      metadata: { seedFixture: true },
    })
    .returning();
  timelineRows.push({
    tenantId: tenant.id, patientId: patientRows[6].id, journeyId: journeyIds[6],
    actorType: "system", eventType: "call_logged", channel: "IVR_CALL", title: "Call missed",
    occurredAt: minutesAgo(305), relatedEntityType: "call", relatedEntityId: ishitaCall.id,
  });
  await db.insert(tasks).values({
    tenantId: tenant.id, patientId: patientRows[6].id, journeyId: journeyIds[6],
    assignedTo: coordinator.id, // Ishita's Journey owner (patientIdx 6 is even -> coordinator, same rule as the JOURNEY_CONFIGS loop above)
    reason: "missed_follow_up", type: "CALLBACK", priority: "high", status: "pending",
    dueAt: daysFromNow(0, 18), notes: "Missed call — call back to complete this enquiry",
    createdBy: admin.id,
  });

  // WhatsApp Journey-linking — the deterministic case: Sneha Reddy's single
  // active Journey gets auto-linked, same as resolveJourneyForNewConversation
  // in whatsapp-webhook.service.ts would produce for her wa_id.
  const snehaWaId = (patientRows[2].phoneE164 ?? patientRows[2].phone).replace("+", "");
  const [snehaConversation] = await db
    .insert(conversations)
    .values({
      tenantId: tenant.id, patientId: patientRows[2].id, channel: "WHATSAPP", ownershipState: "AI_ACTIVE",
      connectorId: whatsappConnector.id, externalThreadId: snehaWaId, communicationEndpointId: whatsappEndpoint.id,
      journeyId: journeyIds[2], lastMessageAt: minutesAgo(40),
    })
    .returning();
  await db.insert(messages).values([
    {
      tenantId: tenant.id, conversationId: snehaConversation.id, senderType: "patient",
      body: "Hi, I wanted to check the next steps after my consultation.",
      sentAt: minutesAgo(45), readAt: minutesAgo(43),
      connectorId: whatsappConnector.id, providerMessageId: "wamid.fixture-sneha-001",
    },
    {
      tenantId: tenant.id, conversationId: snehaConversation.id, senderType: "ai",
      body: "Hi Sneha! Our coordinator will share your treatment plan shortly — anything specific you'd like to know now?",
      sentAt: minutesAgo(40), readAt: minutesAgo(40),
      connectorId: whatsappConnector.id, providerMessageId: "wamid.fixture-sneha-002",
    },
  ]);
  // WhatsApp Journey-linking — the honest ambiguous case: Vikram Kumar
  // (idx 1) genuinely has two concurrent active Journeys ("Fertility", Meta,
  // stage "enquiry" and "General OPD", walk-in, stage "attended" — Patient !=
  // Journey, the product's own north star). No deterministic tie-breaker
  // exists for this today (see whatsapp-webhook.service.ts's own comment on
  // resolveJourneyForNewConversation), so journeyId correctly stays null —
  // updating his existing WhatsApp conversation (from CONVERSATION_CONFIGS
  // above) in place with connector/endpoint metadata rather than forcing a
  // link the real resolution logic would never produce.
  const vikramWaId = (patientRows[1].phoneE164 ?? patientRows[1].phone).replace("+", "");
  await db
    .update(conversations)
    .set({ connectorId: whatsappConnector.id, externalThreadId: vikramWaId, communicationEndpointId: whatsappEndpoint.id })
    .where(eq(conversations.id, conversationRows[2].id));
  await db
    .update(messages)
    .set({ connectorId: whatsappConnector.id, providerMessageId: "wamid.fixture-vikram-001" })
    .where(and(eq(messages.conversationId, conversationRows[2].id), eq(messages.senderType, "patient")));


  if (timelineRows.length > 0) {
    await db.insert(timelineEvents).values(timelineRows);
  }

  // Demo Leads — created through the real createLead() domain function (not
  // hand-inserted rows) so this seed also exercises that code path end to
  // end. A couple get their journeys.contactedAt back-dated directly after
  // creation so the Leads page's Follow-up Due / No Response buckets have
  // realistic demo rows to show.
  const leadInputs: LeadInput[] = [
    {
      name: "Anjali Verma", phone: "9811122001", specialtyKey: "GYNECOLOGY", branchId: branchA.id,
      doctorId: doctorMeera.id, source: "meta", campaignId: metaCampaign.id, journeyType: "Pregnancy Care",
      ownerId: coordinator.id, priority: "high", customFieldValues: { pregnancy_status: true, gestational_week: 24 },
      followUp: { type: "CALLBACK", dueAt: daysFromNow(2, 11).toISOString(), assignedTo: coordinator.id },
    },
    {
      // Multi-touch attribution demo journey (Meta -> Google Search -> Appointment):
      // first touch is Meta, a second Google touchpoint is recorded below.
      name: "Kiran Rao", phone: "9811122002", specialtyKey: "FERTILITY", branchId: branchA.id,
      source: "meta", campaignId: metaCampaign.id, journeyType: "Fertility",
      ownerId: coordinator.id, customFieldValues: { ivf_interest: true, treatment_stage: "Evaluation" },
    },
    {
      name: "Farah Ahmed", phone: "9811122003", specialtyKey: "GYNECOLOGY", branchId: branchB.id,
      source: "meta", campaignId: metaAntenatalCampaign.id, journeyType: "Pregnancy Care",
      ownerId: frontDesk.id, customFieldValues: { pregnancy_status: true, gestational_week: 12 },
    },
    {
      name: "Sunita Patil", phone: "9811122004", specialtyKey: "GYNECOLOGY", branchId: branchB.id,
      source: "meta", campaignId: metaAntenatalCampaign.id, journeyType: "Pregnancy Care",
      ownerId: frontDesk.id, customFieldValues: { pregnancy_status: true, previous_c_section: true },
    },
    {
      name: "Ramya Iyer", phone: "9811122005", specialtyKey: "GYNECOLOGY", branchId: branchA.id,
      doctorId: doctorMeera.id, source: "website", campaignId: websiteCampaign.id, journeyType: "Gynecology Consultation",
      ownerId: coordinator.id, customFieldValues: { pregnancy_status: false },
      followUp: { type: "FOLLOW_UP", dueAt: daysFromNow(1, 10).toISOString(), assignedTo: coordinator.id },
    },
    {
      name: "Geeta Nambiar", phone: "9811122006", specialtyKey: "GYNECOLOGY", branchId: branchA.id,
      source: "walk_in", journeyType: "Gynecology Consultation", ownerId: frontDesk.id, notes: "Walk-in, no prior contact.",
    },
  ];
  const leadResults = await createLeadsInOrder(tenant.id, admin.id, leadInputs);

  // Back-date contact on two journeys (no follow-up task on either) so the
  // Leads page's No Response bucket has realistic rows.
  await db.update(journeys).set({ contactedAt: daysFromNow(-3, 10) }).where(eq(journeys.id, leadResults[2].journeyId)); // Farah
  await db.update(journeys).set({ contactedAt: daysFromNow(-1, 9) }).where(eq(journeys.id, leadResults[3].journeyId)); // Sunita

  // Kiran Rao's second, later touch — same journey, different source.
  // recordTouchpoint (not a hand-inserted row) so first_touch stays Meta
  // and this correctly becomes last_touch.
  await recordTouchpoint(db, {
    tenantId: tenant.id,
    patientId: leadResults[1].patientId,
    journeyId: leadResults[1].journeyId,
    details: { source: "google", occurredAt: daysFromNow(1, 14), utmCampaign: googleCampaign.name },
    campaignId: googleCampaign.id,
  });
  await db.insert(timelineEvents).values({
    tenantId: tenant.id, patientId: leadResults[1].patientId, journeyId: leadResults[1].journeyId,
    actorType: "system", eventType: "source_captured", title: `Also engaged via ${googleCampaign.name}`,
    sourceChannel: "google", occurredAt: daysFromNow(1, 14),
  });

  console.log(`Gynecology tenant: ${tenant.name} (${tenant.id}) — ${JOURNEY_CONFIGS.length} journeys, ${patientRows.length} patients`);
  return { tenantId: tenant.id };
}

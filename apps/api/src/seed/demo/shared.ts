import { and, eq } from "drizzle-orm";
import type { ClinicHours, Edition } from "@pulseos/types";
import { db } from "../../db/client.js";
import {
  appointments,
  branches,
  calls,
  campaignTouchpoints,
  communicationEndpoints,
  connectors,
  connectorSecrets,
  consultationOutcomes,
  conversations,
  customFieldDefinitions,
  customFieldValues,
  journeys,
  leadSources,
  messages,
  patients,
  revenueEvents,
  specialtyTemplates,
  tasks,
  tenantLoginConfigs,
  tenants,
  timelineEvents,
  treatmentDefinitions,
  scheduleResources,
  treatmentOpportunities,
  users,
  type SourceChannelDb,
} from "../../db/schema.js";
import { createLead } from "../../domain/lead/lead.service.js";
import { ensureLeadSources } from "../../domain/lead/lead-source.service.js";
import { encryptSecret } from "../../domain/security/encryption.js";
import { DEMO_TIMEZONE, todaySlot } from "./demo-clock.js";
import { addDays, dayKeyIn, zonedWallTime } from "../../lib/hospital-time.js";
import { normalizePhone } from "../../domain/patient/phone.js";
import { demoEmail } from "../../domain/auth/demo-environments.js";
import type { DemoEnvironmentKey } from "../../domain/auth/demo-environments.js";

// ---------------------------------------------------------------------------
// Builders shared by every demo tenant. Each demo (gynecology.ts,
// ophthalmology.ts) supplies only DATA — patient names, journey configs,
// campaigns — and these builders turn it into rows, so the two tenants can
// never drift apart in how a Journey/Appointment/Treatment is written.
// ---------------------------------------------------------------------------

/** `hour:minute` hospital time, `days` hospital days from today (never the server's clock zone). */
export function daysFromNow(days: number, hour = 10, minute = 0, now: Date = new Date()) {
  return zonedWallTime(addDays(dayKeyIn(now, DEMO_TIMEZONE), days), hour, minute, DEMO_TIMEZONE);
}

const isSunday = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", timeZone: DEMO_TIMEZONE }) === "Sun";

/**
 * When a seeded follow-up is due. Past days: 09:00. Future days: 19:00. TODAY: 19:00, or - when the seed is run in the evening -
 * 90 minutes from now (never past 23:45), so "due later today" is true whenever the demo is seeded, not only before 19:00.
 */
export function taskDueAt(offsetDays: number, now: Date = new Date()): Date {
  if (offsetDays !== 0) return daysFromNow(offsetDays, offsetDays > 0 ? 19 : 9, 0, now);
  const evening = daysFromNow(0, 19, 0, now);
  const lateToday = new Date(Math.min(now.getTime() + 90 * 60_000, daysFromNow(0, 23, 45, now).getTime()));
  return evening.getTime() > now.getTime() + 60 * 60_000 ? evening : lateToday;
}

export function minutesAgo(mins: number) {
  return new Date(Date.now() - mins * 60_000);
}

export type ConversationChannelValue = "WHATSAPP" | "CALL" | "SMS" | "EMAIL" | "INTERNAL";
export type OwnershipStateValue = "AI_ACTIVE" | "HUMAN_REQUIRED" | "HUMAN_ASSIGNED" | "HUMAN_ACTIVE" | "AI_RESUME_PENDING" | "CLOSED";

export interface ConversationConfig {
  patientIdx: number;
  channel: ConversationChannelValue;
  ownershipState: OwnershipStateValue;
  assignedTo: "coordinator" | "frontDesk" | null;
  messages: { sender: "patient" | "staff" | "ai" | "system"; body: string; minutesAgoSent: number; unread?: boolean }[];
}

export type ConsultationOutcomeValue =
  | "CONSULTED"
  | "TREATMENT_ADVISED"
  | "NO_TREATMENT_REQUIRED"
  | "DECISION_PENDING"
  | "FOLLOW_UP_REQUIRED"
  | "REFERRED"
  | "OTHER";

export type TreatmentStatusValue = "ADVISED" | "DECISION_PENDING" | "ACCEPTED" | "SCHEDULED" | "COMPLETED" | "DECLINED" | "CANCELLED" | "LOST";
export type TaskReasonValue = "overdue_callback" | "missed_follow_up" | "no_show" | "high_intent_uncontacted" | "treatment_decision_pending" | "manual_task";
export type TaskTypeValue = "CALLBACK" | "FOLLOW_UP" | "APPOINTMENT_CONFIRMATION" | "NO_SHOW_RECOVERY" | "TREATMENT_DECISION" | "POST_CARE" | "RECALL" | "OTHER";

const TASK_TYPE_BY_REASON: Record<TaskReasonValue, TaskTypeValue> = {
  overdue_callback: "CALLBACK",
  missed_follow_up: "FOLLOW_UP",
  no_show: "NO_SHOW_RECOVERY",
  high_intent_uncontacted: "CALLBACK",
  treatment_decision_pending: "TREATMENT_DECISION",
  manual_task: "OTHER",
};

const TASK_PRIORITY_BY_REASON: Record<TaskReasonValue, "normal" | "high"> = {
  overdue_callback: "normal",
  missed_follow_up: "normal",
  no_show: "high",
  high_intent_uncontacted: "high",
  treatment_decision_pending: "high",
  manual_task: "normal",
};

export type JourneyStageValue = "enquiry" | "contacted" | "booked" | "attended" | "consulted" | "treatment_advised" | "scheduled" | "completed" | "lost";
export type AppointmentStatusValue = "scheduled" | "confirmed" | "checked_in" | "waiting" | "with_doctor" | "completed" | "no_show" | "cancelled";

/** When something happened, as clinic-hours wall-clock — seeded communications should never land at 4 am. */
export interface DemoTime {
  daysAgo: number;
  hour: number;
  minute?: number;
}

const at = (t: DemoTime) => daysFromNow(-t.daysAgo, t.hour, t.minute ?? 0);

export type DemoInteraction =
  | ({
      kind: "call";
      direction: "inbound" | "outbound";
      status: "completed" | "missed" | "no_answer";
      durationSeconds: number;
      endpoint: string; // key into DemoContext.endpoints
      agent?: string;
      summary?: string;
      outcome?: string;
    } & DemoTime)
  | {
      kind: "whatsapp";
      endpoint: string;
      ownershipState?: OwnershipStateValue;
      messages: ({ sender: "patient" | "staff" | "ai"; body: string } & DemoTime)[];
    };

export interface DemoJourneyConfig {
  patientIdx: number;
  /** No owner: the journey (and its task) shows up as Unassigned. */
  unassigned?: boolean;
  journeyType: string;
  specialtyKey?: string;
  source: SourceChannelDb;
  campaignKey: string | null;
  stage: JourneyStageValue;
  contactedOffsetDays: number | null; // null = never contacted
  createdOffsetDays: number;
  /** Hour the journey was opened (default 10). A same-day appointment always pushes this earlier if needed. */
  createdHour?: number;
  /** `hour` applies to past/future days only — same-day (offsetDays 0) times come from the demo clock. */
  appt?: { status: AppointmentStatusValue; offsetDays: number; hour?: number; doctor: string; reason?: string };
  outcome?: { value: ConsultationOutcomeValue; notes?: string };
  /** definitionKey = key into the tenant's treatment catalog; label overrides the catalog label (e.g. "Cataract Surgery — Right Eye"). */
  treatment?: { definitionKey: string; label?: string; status: TreatmentStatusValue; estimatedValue: number; decisionOffsetDays?: number; plannedOffsetDays?: number };
  revenueAmount?: number; // written as a revenue event when treatment status is COMPLETED
  revenueOffsetDays?: number;
  task?: { reason: TaskReasonValue; dueOffsetDays: number; notes?: string; type?: TaskTypeValue };
  /** Specialty custom-field values, keyed by field key (definitions come from the tenant's specialty template). */
  fields?: Record<string, string | number | boolean>;
  interactions?: DemoInteraction[];
}

type UserRow = typeof users.$inferSelect;
type BranchRow = typeof branches.$inferSelect;
type CampaignRow = { id: string; name: string };
type EndpointRow = { id: string };

export interface DemoContext {
  tenantId: string;
  branches: { a: BranchRow; b: BranchRow };
  admin: UserRow;
  coordinator: UserRow;
  /** Optional second coordinator: with it, demo journeys are spread across three staff (frontDesk, coordinator, coordinator2). */
  coordinator2?: UserRow;
  frontDesk: UserRow;
  doctors: Record<string, UserRow>;
  campaigns: Record<string, CampaignRow>;
  patients: (typeof patients.$inferSelect)[];
  runoConnectorId: string;
  whatsappConnectorId: string;
  endpoints: Record<string, EndpointRow>;
  /** Clinic closed on Sundays: appointments on other days that would fall on a Sunday move one day away from today. */
  skipSundays?: boolean;
}

/**
 * Real event timestamps for a seeded appointment, so the queue shows honest waiting times and "completed at"
 * lines. Same-day visits still in flight are timed from NOW (a patient who has waited 14 minutes), the rest from
 * their booked time. `ordinal` staggers several same-status visits.
 */
function lifecycleStamps(status: string, scheduledAt: Date, ordinal: number) {
  const min = (m: number) => new Date(Date.now() + m * 60_000);
  const at = (m: number) => new Date(scheduledAt.getTime() + m * 60_000);
  switch (status) {
    case "checked_in":
      return { checkedInAt: min(-(6 + 5 * ordinal)) };
    case "waiting": {
      const arrived = min(-(16 + 7 * ordinal));
      return { checkedInAt: arrived, waitingStartedAt: new Date(arrived.getTime() + 60_000) };
    }
    case "with_doctor": {
      const arrived = min(-(48 + 6 * ordinal));
      return { checkedInAt: arrived, waitingStartedAt: new Date(arrived.getTime() + 2 * 60_000), consultationStartedAt: min(-(12 + 5 * ordinal)) };
    }
    case "completed": {
      const done = new Date(Math.min(at(40).getTime(), Date.now() - 5 * 60_000));
      const started = new Date(done.getTime() - 20 * 60_000);
      const waited = new Date(started.getTime() - 12 * 60_000);
      return { checkedInAt: new Date(waited.getTime() - 2 * 60_000), waitingStartedAt: waited, consultationStartedAt: started, completedAt: done };
    }
    case "no_show":
      return { noShowAt: at(30), statusReasonCode: "patient_no_show" };
    case "cancelled":
      return { cancelledAt: at(-24 * 60), statusReasonCode: "patient_requested" };
    default:
      return {};
  }
}

/** The safe words of a hospital's own sign-in page (see tenant_login_configs). Every field is optional; defaults cover the rest. */
export interface DemoLoginConfig {
  shortName?: string;
  headline?: string;
  tagline?: string;
  badgeLabel?: string;
  supportText?: string;
}

export async function createDemoTenant(name: string, edition: Edition = "BETA_V2_GROWTH", opts: { loginSlug?: string; login?: DemoLoginConfig; clinicHours?: ClinicHours } = {}) {
  const [tenant] = await db.insert(tenants).values({ name, timezone: "Asia/Kolkata", edition, loginSlug: opts.loginSlug ?? null, clinicHours: opts.clinicHours ?? null }).returning();
  if (opts.loginSlug) await db.insert(tenantLoginConfigs).values({ tenantId: tenant.id, ...opts.login });
  return tenant;
}

export async function createDemoBranches(tenantId: string, defs: [{ name: string; city: string }, { name: string; city: string }] | [{ name: string; city: string }]) {
  const [a, b] = await db
    .insert(branches)
    .values(defs.map((d) => ({ tenantId, ...d })))
    .returning();
  // A single-branch hospital (Namokar): key "b" aliases the one real branch, so no second branch ever exists.
  return { a, b: b ?? a };
}

interface DemoUserDef {
  slug: string; // email slug: "admin", "doctor", "doctor2", "frontdesk", "coordinator"
  name: string;
  role: UserRow["role"];
  branch: "a" | "b";
}

export async function createDemoUsers(
  environment: DemoEnvironmentKey,
  tenantId: string,
  passwordHash: string,
  branchByKey: { a: BranchRow; b: BranchRow },
  defs: DemoUserDef[],
) {
  const rows = await db
    .insert(users)
    .values(defs.map((d) => ({ tenantId, branchId: branchByKey[d.branch].id, name: d.name, email: demoEmail(environment, d.slug), passwordHash, role: d.role })))
    .returning();
  return Object.fromEntries(defs.map((d, i) => [d.slug, rows[i]])) as Record<string, UserRow>;
}

export interface FixtureIdentifiers {
  wabaId: string;
  whatsappAccessToken: string;
  appSecret: string;
  verifyToken: string;
  runoSecret: string;
  gbpLocationId: string;
  gbpAccessToken: string;
  googleKey: string;
  metaPageAccessToken: string;
  intakeToken: string;
}

/** Fixture identifiers unique to one tenant, so two demo tenants never share a secret, token or page id. */
export function fixtureIdentifiers(tag: string): FixtureIdentifiers {
  const lower = tag.toLowerCase();
  return {
    wabaId: `FIXTURE_${tag}_WABA_ID`,
    whatsappAccessToken: `FIXTURE_${tag}_ACCESS_TOKEN`,
    appSecret: `FIXTURE_${tag}_APP_SECRET`,
    verifyToken: `pulseos-fixture-${lower}-verify-token`,
    runoSecret: `pulseos-fixture-${lower}-runo-secret`,
    gbpLocationId: `locations/FIXTURE_${tag}_LOCATION_ID`,
    gbpAccessToken: `FIXTURE_${tag}_GBP_ACCESS_TOKEN`,
    googleKey: `pulseos-fixture-${lower}-google-key`,
    metaPageAccessToken: `FIXTURE_${tag}_PAGE_ACCESS_TOKEN`,
    intakeToken: `pulseos-fixture-${lower}-intake-token`,
  };
}

interface ConnectorRefs {
  /** The webhook integration tests sign requests with these, so the tenant they run against keeps its long-standing values. */
  identifiers: FixtureIdentifiers;
  phoneNumberId: string;
  whatsappNumber: string;
  formIds: string[];
  metaPageId: string;
  /** Runo phone lines. `key` is how a seeded call refers to it. */
  phoneLines: { key: string; number: string; providerRef: string; label: string; isActive: boolean; branch?: "a" | "b" | null }[];
  whatsappLabel: string;
  /** A hospital whose website "I am interested" form is protected: its token (stored encrypted), required service and allowed origins. */
  websiteIntake?: { requireService: boolean; fixedSource: "website"; allowedOrigins: string[] };
}

// Connectors: WhatsApp and Runo are seeded CONNECTED against this local
// system's own fixture webhook harness — genuinely configured and usable
// end-to-end locally, but never claimed as a live connection to a real
// provider. Superfone/Exotel are listed for visibility only, honestly
// NOT_CONFIGURED. Every fixture identifier carries the tenant tag so two
// demo tenants never share a phone-number id, page id or secret.
export async function createDemoConnectors(tenantId: string, branchByKey: { a: BranchRow; b: BranchRow }, refs: ConnectorRefs) {
  const [whatsappConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "MESSAGING", provider: "whatsapp_meta_cloud", status: "CONNECTED", mode: "FIXTURE",
      displayName: "WhatsApp (Meta Cloud API)", capabilities: ["SEND_MESSAGE", "RECEIVE_MESSAGE", "RECEIVE_STATUS"],
      configuration: { phoneNumberId: refs.phoneNumberId, businessAccountId: refs.identifiers.wabaId },
    })
    .returning();
  await db.insert(connectorSecrets).values({
    connectorId: whatsappConnector.id,
    encryptedPayload: encryptSecret({
      accessToken: refs.identifiers.whatsappAccessToken,
      appSecret: refs.identifiers.appSecret,
      webhookVerifyToken: refs.identifiers.verifyToken,
    }),
  });

  const [runoConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "TELEPHONY", provider: "runo", status: "CONNECTED", mode: "FIXTURE",
      displayName: "Runo", capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], configuration: null,
    })
    .returning();
  await db.insert(connectorSecrets).values({
    connectorId: runoConnector.id,
    encryptedPayload: encryptSecret({ webhookSharedSecret: refs.identifiers.runoSecret }),
  });

  const [websiteConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "ACQUISITION", provider: "website_form", status: "CONNECTED", mode: "FIXTURE",
      displayName: "Website Contact Form", capabilities: ["RECEIVE_FORM"], configuration: { formIds: refs.formIds, ...(refs.websiteIntake ?? {}) },
    })
    .returning();
  if (refs.websiteIntake) {
    // Closed door: the website's own server sends this token in a header; it is never in page JavaScript.
    await db.insert(connectorSecrets).values({ connectorId: websiteConnector.id, encryptedPayload: encryptSecret({ intakeToken: refs.identifiers.intakeToken }) });
  }

  // GBP is aggregate location analytics only — SYNC_PERFORMANCE, never
  // RECEIVE_LEAD/RECEIVE_FORM, since it must never create a Patient.
  const [gbpConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "ACQUISITION", provider: "google_business_profile", status: "CONNECTED", mode: "FIXTURE",
      displayName: "Google Business Profile", capabilities: ["SYNC_PERFORMANCE"], configuration: { locationId: refs.identifiers.gbpLocationId },
    })
    .returning();
  await db.insert(connectorSecrets).values({
    connectorId: gbpConnector.id,
    encryptedPayload: encryptSecret({ accessToken: refs.identifiers.gbpAccessToken }),
  });

  const [googleLeadFormsConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "ACQUISITION", provider: "google_ads_lead_forms", status: "CONNECTED", mode: "FIXTURE",
      displayName: "Google Ads Lead Forms", capabilities: ["RECEIVE_LEAD", "SYNC_CAMPAIGNS", "SYNC_SPEND", "EXPORT_CONVERSION"], configuration: {},
    })
    .returning();
  await db.insert(connectorSecrets).values({
    connectorId: googleLeadFormsConnector.id,
    encryptedPayload: encryptSecret({ googleKey: refs.identifiers.googleKey }),
  });

  // Fixture Meta Lead Ads — honestly labeled FIXTURE, never implies a real
  // Meta App Review-approved integration.
  const [metaLeadAdsConnector] = await db
    .insert(connectors)
    .values({
      tenantId, type: "ACQUISITION", provider: "meta_lead_ads", status: "CONNECTED", mode: "FIXTURE",
      displayName: "Meta Lead Ads", capabilities: ["RECEIVE_LEAD", "SYNC_CAMPAIGNS", "SYNC_SPEND", "EXPORT_CONVERSION"],
      configuration: { pageId: refs.metaPageId },
    })
    .returning();
  await db.insert(connectorSecrets).values({
    connectorId: metaLeadAdsConnector.id,
    encryptedPayload: encryptSecret({
      appSecret: refs.identifiers.appSecret,
      webhookVerifyToken: refs.identifiers.verifyToken,
      pageAccessToken: refs.identifiers.metaPageAccessToken,
    }),
  });

  await db.insert(connectors).values([
    { tenantId, type: "TELEPHONY", provider: "superfone", status: "NOT_CONFIGURED", displayName: "Superfone", capabilities: ["INITIATE_CALL", "RECEIVE_CALL_EVENT"], configuration: null },
    { tenantId, type: "TELEPHONY", provider: "exotel", status: "NOT_CONFIGURED", displayName: "Exotel", capabilities: ["INITIATE_CALL", "RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], configuration: null },
  ]);

  const endpointRows = await db
    .insert(communicationEndpoints)
    .values([
      ...refs.phoneLines.map((line) => ({
        tenantId, connectorId: runoConnector.id, branchId: line.branch ? branchByKey[line.branch].id : null,
        type: "PHONE" as const, provider: runoConnector.provider, publicNumber: line.number,
        providerRef: line.providerRef, displayLabel: line.label, isActive: line.isActive,
      })),
      {
        // providerRef intentionally matches whatsappConnector.configuration.phoneNumberId —
        // resolveEndpointByProviderRef only ever exact-matches a real inbound
        // webhook's metadata.phone_number_id against this column.
        tenantId, connectorId: whatsappConnector.id, branchId: null,
        type: "WHATSAPP" as const, provider: whatsappConnector.provider, publicNumber: refs.whatsappNumber,
        providerRef: refs.phoneNumberId, displayLabel: refs.whatsappLabel, isActive: true,
      },
    ])
    .returning();

  const endpointKeys = [...refs.phoneLines.map((l) => l.key), "whatsapp"];
  const endpointsByKey = Object.fromEntries(endpointKeys.map((k, i) => [k, { id: endpointRows[i].id }])) as Record<string, EndpointRow>;

  return { whatsappConnector, runoConnector, endpoints: endpointsByKey };
}

export async function createDemoPatients(tenantId: string, branchByKey: { a: BranchRow; b: BranchRow }, names: string[], phoneBase: number, languages: string[]) {
  return db
    .insert(patients)
    .values(
      names.map((name, i) => {
        // Deterministic and unique per tenant via phoneBase; normalized the
        // same way every real entry point does it, or a seeded patient would
        // be permanently unmatchable by phone against app-created records.
        const phone = `9${phoneBase + i * 137}`;
        const normalized = normalizePhone(phone, "IN");
        return {
          tenantId,
          branchId: i % 2 === 0 ? branchByKey.a.id : branchByKey.b.id,
          name,
          phone,
          phoneE164: normalized.e164,
          phoneCountry: normalized.country,
          preferredLanguage: languages[i % languages.length],
        };
      }),
    )
    .returning();
}

// When the treatment's current status was reached: the payment date once
// completed, the decision date once decided, otherwise the hour after the
// consultation it came out of — never a fixed noon on the consultation day.
function treatmentEventTime(config: DemoJourneyConfig, appointmentAt: Date | null): Date {
  const treatment = config.treatment!;
  if (treatment.status === "COMPLETED" && config.revenueOffsetDays !== undefined) return daysFromNow(config.revenueOffsetDays, 11);
  if (treatment.decisionOffsetDays !== undefined) return daysFromNow(treatment.decisionOffsetDays, 11);
  if (appointmentAt) return new Date(appointmentAt.getTime() + 60 * 60_000);
  return daysFromNow(config.createdOffsetDays, 12);
}

function formatDuration(seconds: number) {
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

// Writes one Patient's Journey and everything hanging off it — touchpoint,
// appointment, outcome, treatment, revenue, task, specialty field values and
// communication history — plus the matching Timeline rows, in the same shape
// the real domain services produce. Returns the Journey ids in config order
// (fixtures elsewhere reference a specific Journey by index) and the Timeline
// rows for the caller to insert once.
/**
 * The demo's journeys carry a coarse platform value (meta/google/…); the catalogue source is more precise. Meta
 * enquiries alternate Instagram / Facebook and "organic" is Direct, so the demo shows real source variety.
 */
function sourceKeyFor(bucket: string, patientIdx: number): string {
  if (bucket === "meta") return patientIdx % 2 === 0 ? "instagram" : "facebook";
  if (bucket === "organic") return "direct";
  return bucket;
}

export async function seedJourneys(ctx: DemoContext, configs: DemoJourneyConfig[]) {
  const timelineRows: (typeof timelineEvents.$inferInsert)[] = [];
  const journeyIds: string[] = [];
  let callSeq = 0;
  const todayOrdinals = new Map<string, number>();

  const defs = await db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.tenantId, ctx.tenantId));
  const defId = new Map(defs.map((d) => [`${d.specialtyKey}:${d.key}`, d.id]));
  await ensureLeadSources(db, ctx.tenantId);
  const sourceByKey = new Map((await db.select().from(leadSources).where(eq(leadSources.tenantId, ctx.tenantId))).map((r) => [r.key, r.id]));
  const departmentByService = new Map((await db.select({ key: specialtyTemplates.key, departmentId: specialtyTemplates.departmentId }).from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, ctx.tenantId))).map((r) => [r.key, r.departmentId]));
  const catalog = new Map((await db.select().from(treatmentDefinitions).where(eq(treatmentDefinitions.tenantId, ctx.tenantId))).map((d) => [d.key, d]));

  for (const config of configs) {
    const patient = ctx.patients[config.patientIdx];
    const owner = config.unassigned ? null : ctx.coordinator2 ? [ctx.frontDesk, ctx.coordinator, ctx.coordinator2][config.patientIdx % 3] : config.patientIdx % 2 === 0 ? ctx.coordinator : ctx.frontDesk;
    const branch = config.patientIdx % 2 === 0 ? ctx.branches.a : ctx.branches.b;
    const doctor = config.appt ? ctx.doctors[config.appt.doctor] : null;

    // Same-day appointments come from the demo clock (see demo-clock.ts) so the
    // clinic queue is realistic whenever the seed runs; other days use the
    // configured hour.
    let scheduledAt: Date | null = null;
    if (config.appt) {
      if (config.appt.offsetDays === 0) {
        const ordinal = todayOrdinals.get(config.appt.status) ?? 0;
        todayOrdinals.set(config.appt.status, ordinal + 1);
        scheduledAt = todaySlot(config.appt.status, ordinal);
      } else {
        let offsetDays = config.appt.offsetDays;
        if (ctx.skipSundays && isSunday(daysFromNow(offsetDays, 12))) offsetDays += offsetDays > 0 ? 1 : -1;
        scheduledAt = daysFromNow(offsetDays, config.appt.hour ?? 9 + (config.patientIdx % 8));
      }
    }

    // A journey opened the same day as its appointment must be opened before it.
    let createdAt = daysFromNow(config.createdOffsetDays, config.createdHour ?? 10);
    if (scheduledAt) createdAt = new Date(Math.min(createdAt.getTime(), scheduledAt.getTime() - 45 * 60_000));
    let contactedAt =
      config.contactedOffsetDays === null ? null
      : config.contactedOffsetDays === config.createdOffsetDays ? new Date(createdAt.getTime() + 10 * 60_000)
      : daysFromNow(config.contactedOffsetDays);
    if (contactedAt && scheduledAt && contactedAt.getTime() > scheduledAt.getTime() - 30 * 60_000) contactedAt = new Date(scheduledAt.getTime() - 30 * 60_000);

    const [journey] = await db
      .insert(journeys)
      .values({
        tenantId: ctx.tenantId,
        patientId: patient.id,
        journeyType: config.journeyType,
        specialtyKey: config.specialtyKey ?? null,
        stage: config.stage,
        source: config.source,
        sourceId: sourceByKey.get(sourceKeyFor(config.source, config.patientIdx)) ?? null,
        departmentId: (config.specialtyKey && departmentByService.get(config.specialtyKey)) || null,
        ownerUserId: owner?.id ?? null,
        contactedAt,
        createdAt,
      })
      .returning();
    journeyIds.push(journey.id);

    const base = { tenantId: ctx.tenantId, patientId: patient.id, journeyId: journey.id };

    timelineRows.push({
      ...base, actorType: "system", eventType: "journey_created", title: `${config.journeyType} journey opened`,
      sourceChannel: sourceKeyFor(config.source, config.patientIdx), occurredAt: createdAt,
    });

    if (config.campaignKey) {
      const campaign = ctx.campaigns[config.campaignKey];
      await db.insert(campaignTouchpoints).values({
        ...base, campaignId: campaign.id, source: config.source, touchType: "first_touch", occurredAt: createdAt,
      });
      timelineRows.push({
        ...base, actorType: "system", eventType: "source_captured", title: `Acquired via ${campaign.name}`,
        sourceChannel: config.source, occurredAt: createdAt,
      });
    }

    for (const [key, value] of Object.entries(config.fields ?? {})) {
      const fieldDefinitionId = defId.get(`${config.specialtyKey}:${key}`);
      if (!fieldDefinitionId) throw new Error(`seed: no custom field ${config.specialtyKey}:${key} defined for tenant`);
      await db.insert(customFieldValues).values({ tenantId: ctx.tenantId, journeyId: journey.id, fieldDefinitionId, value });
    }

    let appointmentId: string | null = null;
    if (config.appt && doctor && scheduledAt) {
      const [appt] = await db
        .insert(appointments)
        .values({
          ...base, branchId: branch.id, doctorUserId: doctor.id, status: config.appt.status,
          scheduledAt, reason: config.appt.reason ?? "Consultation",
          ...lifecycleStamps(config.appt.status, scheduledAt, config.appt.offsetDays === 0 ? (todayOrdinals.get(config.appt.status) ?? 1) - 1 : 0),
        })
        .returning();
      appointmentId = appt.id;
      timelineRows.push({
        ...base, actorType: "system",
        eventType: config.appt.status === "no_show" ? "appointment_no_show" : `appointment_${config.appt.status}`,
        title: config.appt.status === "no_show" ? "Patient did not show up" : `Appointment ${config.appt.status.replace("_", " ")}`,
        occurredAt: scheduledAt, relatedEntityType: "appointment", relatedEntityId: appt.id,
      });
    }

    let outcomeId: string | null = null;
    if (config.outcome && appointmentId && doctor && scheduledAt) {
      const recordedAt = new Date(scheduledAt.getTime() + 30 * 60_000);
      const [outcome] = await db
        .insert(consultationOutcomes)
        .values({ ...base, appointmentId, outcome: config.outcome.value, recordedBy: doctor.id, recordedAt, notes: config.outcome.notes })
        .returning();
      outcomeId = outcome.id;
      timelineRows.push({
        ...base, actorType: "user", actorId: doctor.id, eventType: "consultation_outcome_recorded",
        title: `Consultation outcome: ${config.outcome.value.replace(/_/g, " ").toLowerCase()}`,
        occurredAt: recordedAt, relatedEntityType: "consultation_outcome", relatedEntityId: outcome.id,
      });
    }

    let treatmentId: string | null = null;
    if (config.treatment) {
      const definition = catalog.get(config.treatment.definitionKey);
      if (!definition) throw new Error(`seed: no treatment catalog entry "${config.treatment.definitionKey}" for tenant`);
      const treatmentLabel = config.treatment.label ?? definition.label;
      // The moment the treatment reached its current status (fixture): for a COMPLETED one it is also its completion time.
      const treatmentAt = treatmentEventTime(config, scheduledAt);
      // A SCHEDULED procedure carries who/where (the same fields scheduleSurgery stores): its doctor is the one the
      // story already names, its branch the journey's. Nothing is invented — a story without a planned date stays unscheduled-looking.
      const scheduledResource =
        config.treatment.status === "SCHEDULED" && doctor
          ? (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, ctx.tenantId), eq(scheduleResources.linkedUserId, doctor.id))).limit(1))[0]
          : undefined;
      const [treatment] = await db
        .insert(treatmentOpportunities)
        .values({
          ...base, consultationOutcomeId: outcomeId, treatmentLabel, treatmentDefinitionId: definition.id, status: config.treatment.status,
          estimatedValue: config.treatment.estimatedValue, ownerUserId: owner?.id ?? null,
          decisionDate: config.treatment.decisionOffsetDays !== undefined ? daysFromNow(config.treatment.decisionOffsetDays) : null,
          plannedDate: config.treatment.plannedOffsetDays !== undefined ? daysFromNow(config.treatment.plannedOffsetDays) : null,
          completedAt: config.treatment.status === "COMPLETED" ? treatmentAt : null,
          ...(scheduledResource ? { scheduledResourceId: scheduledResource.id, scheduledBranchId: branch.id } : {}),
        })
        .returning();
      treatmentId = treatment.id;
      timelineRows.push({
        ...base, actorType: "system", eventType: "treatment_status_changed",
        title: `Treatment "${treatmentLabel}" — ${config.treatment.status.replace(/_/g, " ").toLowerCase()}`,
        occurredAt: treatmentAt,
        relatedEntityType: "treatment_opportunity", relatedEntityId: treatment.id,
      });
    }

    if (config.revenueAmount && treatmentId) {
      const occurredAt = daysFromNow(config.revenueOffsetDays ?? 0);
      await db.insert(revenueEvents).values({ ...base, treatmentOpportunityId: treatmentId, amount: config.revenueAmount, type: "treatment_payment", occurredAt });
      timelineRows.push({
        ...base, actorType: "system", eventType: "revenue_recorded",
        title: `Payment received — ₹${config.revenueAmount.toLocaleString("en-IN")}`, occurredAt, relatedEntityType: "revenue_event",
      });
    }

    if (config.task) {
      await db.insert(tasks).values({
        ...base, assignedTo: owner?.id ?? null, reason: config.task.reason, status: "pending", dueAt: taskDueAt(config.task.dueOffsetDays), // "due today" means later today, not already overdue
        type: config.task.type ?? TASK_TYPE_BY_REASON[config.task.reason], priority: TASK_PRIORITY_BY_REASON[config.task.reason],
        notes: config.task.notes, createdBy: ctx.admin.id,
      });
    }

    for (const interaction of config.interactions ?? []) {
      const endpoint = ctx.endpoints[interaction.endpoint];
      if (!endpoint) throw new Error(`seed: unknown communication endpoint "${interaction.endpoint}"`);

      if (interaction.kind === "call") {
        const startedAt = at(interaction);
        const [call] = await db
          .insert(calls)
          .values({
            tenantId: ctx.tenantId, connectorId: ctx.runoConnectorId, communicationEndpointId: endpoint.id,
            patientId: patient.id, journeyId: journey.id,
            externalCallId: `fixture-call-${ctx.tenantId.slice(0, 8)}-${++callSeq}`,
            direction: interaction.direction, phone: patient.phone, status: interaction.status,
            durationSeconds: interaction.durationSeconds, agentName: interaction.agent ?? null,
            disposition: interaction.outcome ?? null,
            startedAt, endedAt: new Date(startedAt.getTime() + interaction.durationSeconds * 1000),
            metadata: { seedFixture: true, summary: interaction.summary ?? null },
          })
          .returning();
        const dirLabel = interaction.direction === "inbound" ? "Incoming" : "Outbound";
        const statusLabel = interaction.status === "completed" ? "" : ` (${interaction.status.replace("_", " ")})`;
        timelineRows.push({
          ...base, actorType: "system", eventType: "call_logged", channel: "IVR_CALL",
          title: `${dirLabel} call${statusLabel} · ${formatDuration(interaction.durationSeconds)}${interaction.agent ? ` · ${interaction.agent}` : ""}`,
          description: [interaction.summary, interaction.outcome ? `Outcome: ${interaction.outcome}` : null].filter(Boolean).join(" "),
          occurredAt: startedAt, relatedEntityType: "call", relatedEntityId: call.id,
        });
        // A missed inbound call surfaces in the Inbox as a CALL conversation,
        // exactly as call-webhook.service does — here backed by the call row above.
        if (interaction.direction === "inbound" && interaction.status === "missed") {
          const [conversation] = await db
            .insert(conversations)
            .values({
              tenantId: ctx.tenantId, patientId: patient.id, journeyId: journey.id, channel: "CALL",
              ownershipState: "HUMAN_ASSIGNED", assignedTo: ctx.coordinator.id, lastMessageAt: startedAt,
            })
            .returning();
          await db.insert(messages).values({
            tenantId: ctx.tenantId, conversationId: conversation.id, senderType: "system",
            body: "Missed call from patient — flagged for follow-up.", sentAt: startedAt, readAt: null,
          });
        }
      } else {
        const sentTimes = interaction.messages.map((m) => at(m).getTime());
        const waId = (patient.phoneE164 ?? patient.phone).replace("+", "");
        const [conversation] = await db
          .insert(conversations)
          .values({
            tenantId: ctx.tenantId, patientId: patient.id, journeyId: journey.id, channel: "WHATSAPP",
            ownershipState: interaction.ownershipState ?? "AI_ACTIVE", connectorId: ctx.whatsappConnectorId,
            externalThreadId: waId, communicationEndpointId: endpoint.id, lastMessageAt: new Date(Math.max(...sentTimes)),
          })
          .returning();
        await db.insert(messages).values(
          interaction.messages.map((m, i) => ({
            tenantId: ctx.tenantId, conversationId: conversation.id, senderType: m.sender,
            senderUserId: m.sender === "staff" ? ctx.coordinator.id : null, body: m.body,
            sentAt: at(m), readAt: at(m),
            connectorId: ctx.whatsappConnectorId, providerMessageId: `wamid.fixture-${ctx.tenantId.slice(0, 8)}-${journey.id.slice(0, 8)}-${i}`,
          })),
        );
        // The Timeline line for this thread (one per conversation session, with its summary) is built after
        // seeding by seedConversationSessions — never one event per message.
      }
    }
  }

  return { journeyIds, timelineRows };
}

export async function seedConversations(ctx: DemoContext, configs: ConversationConfig[]) {
  const rows: (typeof conversations.$inferSelect)[] = [];
  for (const config of configs) {
    const patient = ctx.patients[config.patientIdx];
    const assignedTo = config.assignedTo === "coordinator" ? ctx.coordinator.id : config.assignedTo === "frontDesk" ? ctx.frontDesk.id : null;
    const lastMessageAt = minutesAgo(Math.min(...config.messages.map((m) => m.minutesAgoSent)));

    const [conversation] = await db
      .insert(conversations)
      .values({ tenantId: ctx.tenantId, patientId: patient.id, channel: config.channel, ownershipState: config.ownershipState, assignedTo, lastMessageAt })
      .returning();
    rows.push(conversation);

    await db.insert(messages).values(
      config.messages.map((m) => ({
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        senderType: m.sender,
        senderUserId: m.sender === "staff" ? assignedTo : null,
        body: m.body,
        sentAt: minutesAgo(m.minutesAgoSent),
        readAt: m.sender === "patient" && m.unread ? null : minutesAgo(m.minutesAgoSent),
      })),
    );
  }
  return rows;
}


export type LeadInput = Parameters<typeof createLead>[3];

// Leads go through the real createLead() domain path, one at a time — running
// them concurrently would make creation order (and created_at ordering)
// depend on scheduling, and the seed must be deterministic.
export async function createLeadsInOrder(tenantId: string, actorUserId: string, inputs: LeadInput[]) {
  const results = [];
  for (const input of inputs) {
    const result = await createLead(db, tenantId, actorUserId, input);
    if ("validationError" in result) throw new Error(`seed lead unexpectedly missing required field(s): ${result.missingRequiredFields.join(", ")}`);
    if ("stepError" in result) throw new Error(`seed lead refused at ${result.stepError.step}: ${result.stepError.reason}`);
    results.push(result);
  }
  return results;
}

/**
 * The one Journey seeded for a patient, for tasks created outside the journey
 * builder. Throws when the patient has none or several so a task can never
 * silently lose its Journey (or have one guessed for it).
 */
export function journeyIdForPatient(configs: readonly { patientIdx: number }[], journeyIds: readonly string[], patientIdx: number): string {
  const matches = configs.flatMap((c, i) => (c.patientIdx === patientIdx ? [journeyIds[i]!] : []));
  if (matches.length !== 1) throw new Error(`Seed: patient #${patientIdx} has ${matches.length} journeys — link the task to one explicitly`);
  return matches[0]!;
}

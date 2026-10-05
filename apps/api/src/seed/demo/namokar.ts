import { and, eq, gt, sql } from "drizzle-orm";
import type { ClinicHours, CreateCrmFieldInput } from "@pulseos/types";
import { createCrmField } from "../../domain/crm/crm-field.service.js";
import { db } from "../../db/client.js";
import { appointments, customFieldDefinitions, followUpTypes, notificationRules, notifications, tenantCapabilities, timelineEvents, treatmentOpportunities } from "../../db/schema.js";
import { ensureNotificationDefaults, planForSubject } from "../../domain/notification/notification.service.js";
import { installDepartmentTemplate } from "../../domain/specialty/department.service.js";
import { OPHTHALMOLOGY_TREATMENTS } from "../../domain/specialty/ophthalmology.templates.js";
import { createFollowUpType, ensureFollowUpTypes } from "../../domain/task/followup-type.service.js";
import { createFollowUp, createTask } from "../../domain/task/task.service.js";
import { ensureDefaultOutcomes } from "../../domain/crm/crm-outcome.service.js";
import { assertJourneyConfigsConsistent } from "./consistency.js";
import {
  createDemoBranches,
  createDemoConnectors,
  createDemoPatients,
  createDemoTenant,
  createDemoUsers,
  daysFromNow,
  fixtureIdentifiers,
  journeyIdForPatient,
  seedJourneys,
  type DemoContext,
  type DemoInteraction,
  type DemoJourneyConfig,
} from "./shared.js";

// NAMOKAR EYE & OCULOPLASTY CENTRE - a fictional telecalling / front-desk demo.
//
// Everything is invented: names, numbers and stories. Today's data is RELATIVE to the day the seed runs (journeys
// opened today, a clinic queue with every state, calls from this morning), so the Command Centre, Leads, My Work, Front
// Desk and Appointments all have something real to show at any time. Edition V1 (core CRM + core analytics); Runo and
// WhatsApp notifications run as FIXTURES.

export const NAMOKAR_TENANT_NAME = "Namokar Eye & Oculoplasty Centre";
/** The address of the hospital's own sign-in page: /login/namokar-v1. */
export const NAMOKAR_LOGIN_SLUG = "namokar-v1";
/** The clean pilot workspace (configuration only): /login/namokar-v2. */
export const NAMOKAR_V2_TENANT_NAME = "Namokar Eye & Oculoplasty Centre (Pilot)";
export const NAMOKAR_V2_LOGIN_SLUG = "namokar-v2";
/** Namokar's clinic week (both tenants): Monday to Saturday 09:00-16:00, closed Sunday. */
export const NAMOKAR_CLINIC_HOURS: ClinicHours = {
  mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null,
};

export const NAMOKAR_PATIENT_NAMES = [
  "Suresh Kulkarni", "Rajan Pillai", "Anjali Deshmukh", "Tanvi Rao", "Mahesh Reddy", "Kamala Bai Jadhav", "Sunita Patil", "Neelam Gupta",
  "Pradeep Joshi", "Farida Shaikh", "Rohit Agarwal", "Lata Pawar", "Deepak Mehta", "Imran Qureshi", "Pooja Naik", "Gauri Kulkarni",
  "Vivek Sharma", "Nikhil Bhosale", "Shilpa Joshi", "Zainab Khan", "Harish Menon", "Rekha Dixit", "Sanjay Rathod", "Madhuri Apte",
  "Prakash Jadhav", "Seema Thakur",
  "Bhaskar Nene", "Lalita Sawant", "Kiran Deshpande",
];

/** The flagship story: a Google enquiry that follows the WHOLE pilot path, with every step on its timeline. */
export const NAMOKAR_FLAGSHIP_PATIENT_IDX = 1;

const call = (c: Omit<Extract<DemoInteraction, { kind: "call" }>, "kind" | "endpoint">): DemoInteraction => ({ kind: "call", endpoint: "main", ...c });

// Journeys are spread over the three telecallers: Front Desk, Shivani and Sushil.
// The only doctor is Dr. Poonam Jain ("poonam").
export const NAMOKAR_JOURNEYS: DemoJourneyConfig[] = [
  // A - Cataract. Incoming call -> interested -> booked -> attended -> consultation completed (surgery advised).
  {
    patientIdx: 0, journeyType: "Cataract", specialtyKey: "CATARACT", source: "phone", campaignKey: null, stage: "treatment_advised",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 8,
    appt: { status: "completed", offsetDays: 0, doctor: "poonam", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Cataract surgery advised for the right eye; the patient will discuss it with family." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "ADVISED", estimatedValue: 42_000 },
    interactions: [call({ direction: "inbound", status: "completed", durationSeconds: 238, daysAgo: 0, hour: 8, minute: 0, agent: "Front Desk", summary: "Caller asked about cataract surgery and whether a consultation is needed first.", outcome: "Consultation booked for today." })],
  },
  // FLAGSHIP - Cataract. Google enquiry -> phoned and contacted -> consultation booked -> WhatsApp confirmation (fixture) -> arrived,
  // checked in, waited, seen by the doctor -> consultation completed -> cataract surgery advised -> procedure scheduled -> a
  // pre-operative follow-up is due. Every step is on the timeline (the extra lines are written below, from the visit's own stamps).
  {
    patientIdx: 1, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: null, stage: "scheduled",
    contactedOffsetDays: -9, createdOffsetDays: -9, createdHour: 10,
    appt: { status: "completed", offsetDays: -3, hour: 11, doctor: "poonam", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Cataract surgery advised for the left eye; the patient agreed and a date was fixed." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Left Eye", status: "SCHEDULED", estimatedValue: 42_000, decisionOffsetDays: -3, plannedOffsetDays: 5 },
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 215, daysAgo: 9, hour: 10, minute: 40, agent: "Front Desk", summary: "Replied to the Google enquiry by phone; the patient has blurred vision in the left eye and wants it checked.", outcome: "Consultation booked." })],
  },
  // B - LASIK. Instagram enquiry -> outgoing follow-up -> booked -> currently Waiting.
  {
    patientIdx: 2, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "meta", campaignKey: null, stage: "attended",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 8,
    appt: { status: "waiting", offsetDays: 0, doctor: "poonam", reason: "LASIK screening" },
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 192, daysAgo: 0, hour: 8, minute: 20, agent: "Shivani", summary: "Followed up on the Instagram enquiry; the patient wants to know whether LASIK suits a -5 power.", outcome: "Screening booked for today." })],
  },
  {
    patientIdx: 3, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "meta", campaignKey: null, stage: "contacted",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 9,
    interactions: [call({ direction: "inbound", status: "completed", durationSeconds: 156, daysAgo: 0, hour: 9, minute: 40, agent: "Front Desk", summary: "Asked about LASIK vs SMILE cost and who is eligible.", outcome: "Screening booking pending." })],
  },
  // E - General eye consultation, walk-in, Checked In.
  {
    patientIdx: 4, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "walk_in", campaignKey: null, stage: "attended",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 9,
    appt: { status: "checked_in", offsetDays: 0, doctor: "poonam", reason: "General eye check-up" },
  },
  // F - Cataract. The patient asked for a callback tomorrow (a Callback task is created below).
  {
    patientIdx: 5, journeyType: "Cataract", specialtyKey: "CATARACT", source: "phone", campaignKey: null, stage: "contacted",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 9,
    interactions: [call({ direction: "inbound", status: "completed", durationSeconds: 301, daysAgo: 0, hour: 9, minute: 20, agent: "Front Desk", summary: "An elderly caller wants a cataract check but asked us to ring tomorrow morning, when her son is home.", outcome: "Callback requested for tomorrow 11:00." })],
  },
  // D - Ptosis (oculoplasty). Booked yesterday, did not show up today (an Appointment Risk follow-up is created below).
  {
    patientIdx: 6, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "meta", campaignKey: null, stage: "booked",
    contactedOffsetDays: -1, createdOffsetDays: -1,
    appt: { status: "no_show", offsetDays: 0, doctor: "poonam", reason: "Ptosis consultation" },
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 168, daysAgo: 1, hour: 12, minute: 10, agent: "Shivani", summary: "Drooping upper eyelid enquiry; booked a consultation for this morning.", outcome: "Consultation booked." })],
  },
  // H - Oculoplasty. Consultation completed today, ptosis correction accepted; a Surgery Follow-up is created below.
  {
    patientIdx: 7, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "google", campaignKey: null, stage: "treatment_advised",
    contactedOffsetDays: -3, createdOffsetDays: -3,
    appt: { status: "completed", offsetDays: 0, doctor: "poonam", reason: "Oculoplasty consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Ptosis correction advised for the left eyelid; the patient agreed to proceed." },
    treatment: { definitionKey: "PTOSIS_CORRECTION", label: "Ptosis Correction — Left Eyelid", status: "ACCEPTED", estimatedValue: 55_000, decisionOffsetDays: 0 },
    interactions: [call({ direction: "inbound", status: "completed", durationSeconds: 214, daysAgo: 3, hour: 11, minute: 30, agent: "Front Desk", summary: "Asked about eyelid surgery for a drooping lid.", outcome: "Consultation booked." })],
  },
  // C - Oculoplasty. Missed IVR call this morning; the callback is due today and nobody has contacted the patient yet.
  {
    patientIdx: 8, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "phone", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: 0, createdHour: 10,
    task: { reason: "overdue_callback", dueOffsetDays: 0, type: "CALLBACK", notes: "Missed IVR call at 10:05 about a drooping eyelid - call the patient back and offer a consultation" },
    interactions: [call({ direction: "inbound", status: "missed", durationSeconds: 0, daysAgo: 0, hour: 10, minute: 5, summary: "Missed call to the telecalling line.", outcome: "No answer - callback needed." })],
  },
  // With the doctor right now.
  {
    patientIdx: 9, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: null, stage: "attended",
    contactedOffsetDays: -2, createdOffsetDays: -2,
    appt: { status: "with_doctor", offsetDays: 0, doctor: "poonam", reason: "Cataract consultation" },
  },
  // G - LASIK. Several call attempts, no answer.
  {
    patientIdx: 10, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1, createdHour: 16,
    task: { reason: "missed_follow_up", dueOffsetDays: 0, type: "FOLLOW_UP", notes: "Three attempts, no answer - try WhatsApp or a different time of day" },
    interactions: [
      call({ direction: "outbound", status: "no_answer", durationSeconds: 0, daysAgo: 1, hour: 17, minute: 10, agent: "Shivani", summary: "No answer.", outcome: "Will retry." }),
      call({ direction: "outbound", status: "no_answer", durationSeconds: 0, daysAgo: 0, hour: 9, minute: 30, agent: "Shivani", summary: "No answer.", outcome: "Will retry." }),
      call({ direction: "outbound", status: "no_answer", durationSeconds: 0, daysAgo: 0, hour: 11, minute: 15, agent: "Shivani", summary: "Rang out again.", outcome: "Try WhatsApp." }),
    ],
  },
  // Booked for today, not yet arrived (Confirmed).
  {
    patientIdx: 11, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "google", campaignKey: null, stage: "booked",
    contactedOffsetDays: -1, createdOffsetDays: -1,
    appt: { status: "confirmed", offsetDays: 0, doctor: "poonam", reason: "Oculoplasty consultation" },
  },
  {
    patientIdx: 12, journeyType: "Cataract", specialtyKey: "CATARACT", source: "whatsapp", campaignKey: null, stage: "contacted",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 10,
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 205, daysAgo: 0, hour: 10, minute: 40, agent: "Shivani", summary: "Replied to the WhatsApp enquiry by phone; wants to bring a family member.", outcome: "Will confirm a slot." })],
  },
  {
    patientIdx: 13, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: null, stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -2,
    appt: { status: "confirmed", offsetDays: 0, doctor: "poonam", reason: "LASIK screening" },
  },
  // A new enquiry nobody has contacted yet (Unassigned).
  {
    patientIdx: 14, unassigned: true, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "meta", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: 0, createdHour: 10,
  },
  // Treatment decision pending: counselling call due today.
  {
    patientIdx: 15, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "google", campaignKey: null, stage: "treatment_advised",
    contactedOffsetDays: -9, createdOffsetDays: -9,
    appt: { status: "completed", offsetDays: -5, hour: 12, doctor: "poonam", reason: "LASIK screening" },
    outcome: { value: "TREATMENT_ADVISED", notes: "LASIK advised; the patient is comparing it with SMILE." },
    treatment: { definitionKey: "LASIK", status: "DECISION_PENDING", estimatedValue: 90_000, decisionOffsetDays: 2 },
    task: { reason: "treatment_decision_pending", dueOffsetDays: 0, notes: "Call to help compare LASIK and SMILE (cost and recovery) and note the patient's preference" },
  },
  {
    patientIdx: 16, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "referral", campaignKey: null, stage: "contacted",
    contactedOffsetDays: 0, createdOffsetDays: 0, createdHour: 9,
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 140, daysAgo: 0, hour: 9, minute: 45, agent: "Shivani", summary: "Referred by a family friend; asked about check-up timings.", outcome: "Will visit this week." })],
  },
  // Converted: surgery done and paid.
  {
    patientIdx: 17, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: null, stage: "completed",
    contactedOffsetDays: -16, createdOffsetDays: -16,
    appt: { status: "completed", offsetDays: -14, hour: 10, doctor: "poonam", reason: "Cataract consultation" },
    outcome: { value: "TREATMENT_ADVISED", notes: "Cataract surgery advised for the right eye." },
    treatment: { definitionKey: "CATARACT_SURGERY", label: "Cataract Surgery — Right Eye", status: "COMPLETED", estimatedValue: 42_000, decisionOffsetDays: -12, plannedOffsetDays: -9 },
  },
  // A new enquiry, uncontacted (Unassigned, with an unassigned first-call task).
  {
    patientIdx: 18, unassigned: true, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: 0, createdHour: 11,
    task: { reason: "high_intent_uncontacted", dueOffsetDays: 0, type: "CALLBACK", notes: "New enquiry nobody owns yet - assign it and make the first call" },
  },
  // Lost: not interested.
  {
    patientIdx: 19, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "referral", campaignKey: null, stage: "lost",
    contactedOffsetDays: -6, createdOffsetDays: -8,
    interactions: [call({ direction: "outbound", status: "completed", durationSeconds: 96, daysAgo: 6, hour: 12, minute: 0, agent: "Shivani", summary: "The patient decided not to go ahead for now (cost).", outcome: "Not interested." })],
  },
  // Booked for the next two days.
  {
    patientIdx: 20, journeyType: "Cataract", specialtyKey: "CATARACT", source: "google", campaignKey: null, stage: "booked",
    contactedOffsetDays: -1, createdOffsetDays: -1,
    appt: { status: "confirmed", offsetDays: 1, hour: 11, doctor: "poonam", reason: "Cataract consultation" },
  },
  {
    patientIdx: 21, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "phone", campaignKey: null, stage: "booked",
    contactedOffsetDays: -2, createdOffsetDays: -3,
    // Booked but not yet confirmed (the others are confirmed), so both "Appointment booked" and "confirmed" are on screen.
    appt: { status: "scheduled", offsetDays: 2, hour: 12, doctor: "poonam", reason: "LASIK screening" },
  },
  // Seen yesterday; no treatment needed.
  {
    patientIdx: 22, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "walk_in", campaignKey: null, stage: "consulted",
    contactedOffsetDays: -1, createdOffsetDays: -1,
    appt: { status: "completed", offsetDays: -1, hour: 15, doctor: "poonam", reason: "General eye check-up" },
    outcome: { value: "NO_TREATMENT_REQUIRED", notes: "Routine check-up; new reading glasses prescribed." },
  },
  // No response / overdue callbacks.
  {
    patientIdx: 23, journeyType: "Cataract", specialtyKey: "CATARACT", source: "phone", campaignKey: null, stage: "contacted",
    contactedOffsetDays: -4, createdOffsetDays: -5,
    task: { reason: "overdue_callback", dueOffsetDays: -2, type: "CALLBACK", notes: "Said she would decide in a few days - check in" },
  },
  {
    patientIdx: 24, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "google", campaignKey: null, stage: "contacted",
    contactedOffsetDays: -3, createdOffsetDays: -3,
    task: { reason: "missed_follow_up", dueOffsetDays: -1, type: "FOLLOW_UP", notes: "Follow-up after the first call went unanswered" },
  },
  {
    patientIdx: 25, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION", source: "meta", campaignKey: null, stage: "contacted",
    contactedOffsetDays: -1, createdOffsetDays: -1,
  },
  // A website "I am interested" enquiry from yesterday evening that nobody has contacted yet (uncontacted, not new today, Unassigned).
  {
    patientIdx: 26, unassigned: true, journeyType: "Cataract", specialtyKey: "CATARACT", source: "website", campaignKey: null, stage: "enquiry",
    contactedOffsetDays: null, createdOffsetDays: -1, createdHour: 18,
  },
  // Consultation completed today; the doctor has not recorded an outcome yet (shows under "awaiting outcome").
  {
    patientIdx: 27, journeyType: "General Eye Consultation", specialtyKey: "GENERAL_EYE_CONSULTATION", source: "phone", campaignKey: null, stage: "consulted",
    contactedOffsetDays: -1, createdOffsetDays: -1,
    appt: { status: "completed", offsetDays: 0, doctor: "poonam", reason: "General eye check-up" },
  },
  // Consultation completed today with a review / follow-up outcome and its follow-up task.
  {
    patientIdx: 28, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: "referral", campaignKey: null, stage: "consulted",
    contactedOffsetDays: -2, createdOffsetDays: -2,
    appt: { status: "completed", offsetDays: 0, doctor: "poonam", reason: "Oculoplasty consultation" },
    outcome: { value: "FOLLOW_UP_REQUIRED", notes: "Review in a week to check the eyelid swelling." },
    task: { reason: "missed_follow_up", dueOffsetDays: 6, type: "FOLLOW_UP", notes: "Review after the consultation" },
  },
];

const clockIn = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const dayLabel = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/**
 * The flagship journey's full trail, from the visit's OWN stamps (so the timeline can never disagree with the appointment):
 * booked -> WhatsApp confirmation (a FIXTURE: nothing is sent) -> confirmed -> checked in -> waiting -> with doctor -> completed
 * -> surgery scheduled. Everything is fictional.
 */
async function seedFlagshipTrail(i: { tenantId: string; journeyId: string; patientId: string; patientFirstName: string; frontDeskId: string; doctorName: string }) {
  const [visit] = await db.select().from(appointments).where(eq(appointments.journeyId, i.journeyId)).limit(1);
  if (!visit?.checkedInAt || !visit.waitingStartedAt || !visit.consultationStartedAt || !visit.completedAt) throw new Error("seed: the flagship visit must carry its full lifecycle stamps");
  const bookedAt = daysFromNow(-9, 10, 50);
  const sentAt = new Date(bookedAt.getTime() + 2 * 60_000);
  const text = `Hello ${i.patientFirstName}, your consultation at ${NAMOKAR_TENANT_NAME} is booked for ${dayLabel(visit.scheduledAt)} at ${clockIn(visit.scheduledAt)} with ${i.doctorName}. Reply YES to confirm.`;
  const [sent] = await db
    .insert(notifications)
    .values({
      tenantId: i.tenantId, subjectType: "APPOINTMENT", subjectId: visit.id, patientId: i.patientId, journeyId: i.journeyId, channel: "WHATSAPP",
      subjectAt: visit.scheduledAt, scheduledFor: sentAt, status: "READ", attempts: 1, providerMessageId: "wamid.fixture-namokar-flagship",
      renderedText: text, idempotencyKey: `seed-flagship-confirmation-${visit.id}`, createdBy: i.frontDeskId,
      sentAt, deliveredAt: new Date(sentAt.getTime() + 60_000), readAt: new Date(sentAt.getTime() + 9 * 60_000),
    })
    .returning();
  const base = { tenantId: i.tenantId, patientId: i.patientId, journeyId: i.journeyId };
  const step = (eventType: string, title: string, occurredAt: Date, extra: Partial<typeof timelineEvents.$inferInsert> = {}): typeof timelineEvents.$inferInsert => ({
    ...base, actorType: "user", eventType, title, occurredAt, relatedEntityType: "appointment", relatedEntityId: visit.id, ...extra,
  });
  const [treatment] = await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, i.journeyId)).limit(1);
  if (!treatment?.plannedDate) throw new Error("seed: the flagship procedure must be scheduled");
  await db.insert(timelineEvents).values([
    step("appointment_created", `Appointment booked · ${dayLabel(visit.scheduledAt)}, ${clockIn(visit.scheduledAt)}`, bookedAt, { actorId: i.frontDeskId, description: "Booked by Front Desk" }),
    step("whatsapp_sent", "WhatsApp confirmation sent (fixture)", sentAt, { actorType: "system", channel: "WHATSAPP", description: text, relatedEntityType: "notification", relatedEntityId: sent!.id }),
    step("appointment_confirmed", "Appointment confirmed", new Date(sentAt.getTime() + 9 * 60_000), { actorType: "system", description: "The patient replied YES on WhatsApp" }),
    step("appointment_checked_in", `Checked in · ${clockIn(visit.checkedInAt)}`, visit.checkedInAt, { actorId: i.frontDeskId }),
    step("appointment_waiting", `Waiting · ${clockIn(visit.waitingStartedAt)}`, visit.waitingStartedAt, { actorId: i.frontDeskId }),
    step("appointment_with_doctor", `Consultation started · ${clockIn(visit.consultationStartedAt)}`, visit.consultationStartedAt, { actorId: i.frontDeskId }),
    step("appointment_completed", `Consultation completed · ${clockIn(visit.completedAt)}`, visit.completedAt, { actorId: i.frontDeskId }),
    step("surgery_scheduled", `Surgery scheduled · ${treatment.treatmentLabel}`, new Date(visit.completedAt.getTime() + 12 * 60_000), {
      actorId: i.frontDeskId, description: `Planned for ${dayLabel(treatment.plannedDate)} with ${i.doctorName}`, relatedEntityType: "treatment_opportunity", relatedEntityId: treatment.id,
    }),
  ]);
}

/**
 * Namokar's first lead entry stays short: name, phone, how they reached us, the service, and who looks after it. The ophthalmology
 * template's clinical questions (eye concern, laterality, diabetes ...) are NOT asked on Add Lead - they remain on the journey and the
 * patient record, where they are captured progressively and can be edited later. A hospital that wants one back on Add Lead switches
 * it on in Settings → CRM Fields ("Add Lead"); nothing is deleted.
 */
/**
 * The registration facts Namokar's front desk talked about, as ordinary CRM fields (the same engine every hospital configures in
 * Settings → CRM Fields - nothing hospital-specific in the code):
 *   Patient type (New / Existing) - asked on Add Lead, because it decides what to ask next;
 *   Namokar UID - appears ONLY for an Existing patient (a New patient gets theirs later, at registration; nothing is invented);
 *   Address, PIN code, Area / Locality, Gender - available on the journey and the patient record, NOT on Add Lead and never
 *   required: the Super Admin switches "On Add Lead" or "Required" on when the clinic wants them at first contact.
 * Area and Gender are filterable, so they can also drive the demographic view in Performance.
 */
async function installPatientIdentityFields(tenantId: string) {
  const here = ["journey_detail", "patient_360"] as const;
  const fields: CreateCrmFieldInput[] = [
    { specialtyKey: "*", key: "patient_type", label: "Patient type", fieldType: "SELECT", options: ["New Patient", "Existing Patient"], groupKey: "patient_information", placements: ["add_lead", ...here], filterable: true },
    { specialtyKey: "*", key: "namokar_uid", label: "Namokar UID", fieldType: "TEXT", groupKey: "patient_information", placements: ["add_lead", ...here], filterable: true, rules: [{ when: { field: "patient_type", equals: ["Existing Patient"] }, then: "show" }] },
    { specialtyKey: "*", key: "address", label: "Address", fieldType: "LONG_TEXT", groupKey: "patient_information", placements: [...here] },
    { specialtyKey: "*", key: "pin_code", label: "PIN code", fieldType: "TEXT", groupKey: "patient_information", placements: [...here] },
    { specialtyKey: "*", key: "area_locality", label: "Area / Locality", fieldType: "TEXT", groupKey: "patient_information", placements: [...here], filterable: true },
    { specialtyKey: "*", key: "gender", label: "Gender", fieldType: "SELECT", options: ["Female", "Male", "Other"], groupKey: "patient_information", placements: [...here], filterable: true },
  ];
  for (const f of fields) {
    const made = await createCrmField(db, tenantId, f);
    if (!made.ok) throw new Error(`Namokar identity field ${f.key} could not be created: ${made.reason}`);
  }
}

/**
 * Oculoplasty enquiries often need a photo first. This is an ordinary follow-up TYPE (Settings → Follow-up Types): the coordinator gets
 * a "Request photo on WhatsApp" task on the journey - a reminder to do it, recorded when done. It is NOT a sent message: nothing is
 * claimed as sent, and no WhatsApp provider is needed. Sending a photo request through the provider would need a second approved
 * message template and a template chooser; that is deliberately left for later (see docs).
 */
async function addPhotoRequestFollowUp(tenantId: string) {
  const made = await createFollowUpType(db, tenantId, { label: "Request photo on WhatsApp", canonicalTaskType: "FOLLOW_UP", defaultPriority: "normal", requiresNote: false });
  if (!made.ok) throw new Error(`photo request follow-up type could not be created: ${made.reason}`);
}

async function keepAddLeadSimple(tenantId: string) {
  await db
    .update(customFieldDefinitions)
    .set({ placements: sql`coalesce((select jsonb_agg(p) from jsonb_array_elements(${customFieldDefinitions.placements}) p where p <> '"add_lead"'::jsonb), '[]'::jsonb)` })
    .where(eq(customFieldDefinitions.tenantId, tenantId));
}

export async function seedNamokarTenant(passwordHash: string) {
  assertJourneyConfigsConsistent("namokar", NAMOKAR_JOURNEYS, NAMOKAR_PATIENT_NAMES, new Set(OPHTHALMOLOGY_TREATMENTS.map((t) => t.key)));
  const tenant = await createDemoTenant(NAMOKAR_TENANT_NAME, "BETA_V1_CORE", {
    loginSlug: NAMOKAR_LOGIN_SLUG,
    // The approved Namokar sign-in: "PulseOS × Namokar", the full name, one operational line, the V1 Demo badge. No logo yet (none is approved):
    // the page uses the typographic fallback. Add an approved mark as /brand/<file> and set logo_path - nothing else changes.
    login: { shortName: "Namokar", tagline: "Every enquiry, call, appointment and follow-up for your patients, in one place.", badgeLabel: "V1 Demo" },
    clinicHours: NAMOKAR_CLINIC_HOURS,
  });
  // Namokar does not run a revenue workflow. This is the hospital's own switch (not an edition default), so the V1 defaults
  // can never turn it back on: no revenue figures, no payments, no revenue-based ROAS anywhere.
  await db.insert(tenantCapabilities).values({ tenantId: tenant.id, capability: "REVENUE_TRACKING", enabled: false });
  await installDepartmentTemplate(db, tenant.id, "ophthalmology");
  await keepAddLeadSimple(tenant.id);
  await installPatientIdentityFields(tenant.id);

  const branchByKey = await createDemoBranches(tenant.id, [
    { name: "Namokar Eye & Oculoplasty Centre", city: "Ashok Vihar, New Delhi" },
  ]);

  // Runo and WhatsApp are FIXTURES here: nothing real is contacted.
  const { whatsappConnector, runoConnector, endpoints } = await createDemoConnectors(tenant.id, branchByKey, {
    identifiers: fixtureIdentifiers("NAMOKAR"),
    phoneNumberId: "FIXTURE_NAMOKAR_PHONE_NUMBER_ID",
    whatsappNumber: "+91 98100 55200",
    whatsappLabel: "WhatsApp Line",
    formIds: ["namokar-enquiry-v1", "namokar-interested"],
    // The website "I am interested" form is a closed door (fixture token, hospital-specific): see docs/namokar/NAMOKAR_WEBSITE_INTAKE.md.
    websiteIntake: { requireService: true, fixedSource: "website", allowedOrigins: ["https://www.namokar-eye.example"] },
    metaPageId: "FIXTURE_NAMOKAR_PAGE_ID",
    phoneLines: [
      { key: "main", number: "+91 20 4155 0200", providerRef: "NAMOKAR-TELECALLING", label: "Telecalling Desk", isActive: true, branch: "a" },
      { key: "reception", number: "+91 20 4155 0201", providerRef: "NAMOKAR-RECEPTION", label: "Reception", isActive: true, branch: "a" },
    ],
  });

  const staff = await createDemoUsers("namokar", tenant.id, passwordHash, branchByKey, [
    // The owner: Namokar's Super Admin, tenant-scoped like every Super Admin (it can never see another hospital).
    { slug: "superadmin", name: "Dr. Rajesh Shah", role: "SUPER_ADMIN", branch: "a" },
    { slug: "admin", name: "Kavita Shah", role: "HOSPITAL_ADMIN", branch: "a" },
    { slug: "doctor", name: "Dr. Poonam Jain", role: "DOCTOR", branch: "a" },
    { slug: "frontdesk", name: "Front Desk", role: "FRONT_DESK", branch: "a" },
    { slug: "coordinator", name: "Shivani", role: "PATIENT_COORDINATOR", branch: "a" },
    { slug: "coordinator2", name: "Sushil", role: "PATIENT_COORDINATOR", branch: "a" },
  ]);
  const { admin, coordinator, coordinator2, frontdesk: frontDesk } = staff;

  const patientRows = await createDemoPatients(tenant.id, branchByKey, NAMOKAR_PATIENT_NAMES, 720_000_000, ["Marathi", "Hindi", "English"]);
  const ctx: DemoContext = {
    tenantId: tenant.id, branches: branchByKey, admin, coordinator, coordinator2, frontDesk,
    doctors: { poonam: staff.doctor }, campaigns: {}, patients: patientRows, skipSundays: true,
    runoConnectorId: runoConnector.id, whatsappConnectorId: whatsappConnector.id, endpoints,
  };

  const { journeyIds, timelineRows } = await seedJourneys(ctx, NAMOKAR_JOURNEYS);
  const flagshipJourneyId = journeyIdForPatient(NAMOKAR_JOURNEYS, journeyIds, NAMOKAR_FLAGSHIP_PATIENT_IDX);
  // The flagship gets a step-by-step visit timeline below, so the generic one-line visit event is dropped for it (never both).
  const generalRows = timelineRows.filter((r) => !(r.journeyId === flagshipJourneyId && String(r.eventType).startsWith("appointment_")));
  if (generalRows.length > 0) await db.insert(timelineEvents).values(generalRows);

  const journeyOf = (patientIdx: number) => journeyIdForPatient(NAMOKAR_JOURNEYS, journeyIds, patientIdx);
  const owner = (patientIdx: number) => [frontDesk, coordinator, coordinator2][patientIdx % 3]!;
  const TZ = "Asia/Kolkata";
  await ensureFollowUpTypes(db, tenant.id);
  await addPhotoRequestFollowUp(tenant.id);
  const typeId = async (key: string) => (await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenant.id), eq(followUpTypes.key, key))))[0]!.id;
  const must = (label: string, r: { ok: boolean; reason?: string }) => {
    if (!r.ok) throw new Error(`seed: ${label} failed (${String(r.reason)})`);
  };

  await seedFlagshipTrail({ tenantId: tenant.id, journeyId: flagshipJourneyId, patientId: patientRows[NAMOKAR_FLAGSHIP_PATIENT_IDX].id, patientFirstName: NAMOKAR_PATIENT_NAMES[NAMOKAR_FLAGSHIP_PATIENT_IDX].split(" ")[0]!, frontDeskId: frontDesk.id, doctorName: staff.doctor.name });
  // The flagship's pre-operative follow-up: the cataract surgery is booked, someone must still brief the patient.
  must("flagship pre-operative follow-up", await createFollowUp(db, tenant.id, { id: coordinator.id }, flagshipJourneyId, { followUpTypeId: await typeId("surgery_followup"), dueAt: daysFromNow(4, 10).toISOString(), assignedTo: owner(NAMOKAR_FLAGSHIP_PATIENT_IDX).id, note: "Pre-operative instructions and the fasting reminder before the cataract surgery" }, TZ));

  // F - the patient asked for a callback tomorrow at 11:00.
  must("callback tomorrow", await createTask(db, tenant.id, owner(5).id, { patientId: patientRows[5].id, journeyId: journeyOf(5), type: "CALLBACK", assignedTo: owner(5).id, dueAt: daysFromNow(1, 11).toISOString(), notes: "Caller asked to be rung tomorrow morning after her son is home" }, TZ));
  // Another upcoming callback: LASIK enquiry, day after tomorrow.
  must("callback in two days", await createTask(db, tenant.id, owner(25).id, { patientId: patientRows[25].id, journeyId: journeyOf(25), type: "CALLBACK", assignedTo: owner(25).id, dueAt: daysFromNow(2, 12).toISOString(), notes: "Patient is travelling - call after the weekend to book the LASIK screening" }, TZ));
  // D - the no-show: an Appointment Risk follow-up so the front desk rebooks it.
  must("appointment risk", await createFollowUp(db, tenant.id, { id: coordinator.id }, journeyOf(6), { followUpTypeId: await typeId("appointment_risk"), dueAt: daysFromNow(1, 9, 30).toISOString(), assignedTo: owner(6).id, note: "Did not arrive for the ptosis consultation - call to rebook" }, TZ));
  // H - an upcoming Surgery Follow-up after the accepted ptosis correction.
  must("surgery follow-up", await createFollowUp(db, tenant.id, { id: coordinator.id }, journeyOf(7), { followUpTypeId: await typeId("surgery_followup"), dueAt: daysFromNow(2, 10, 30).toISOString(), assignedTo: owner(7).id, note: "Confirm the ptosis correction date and pre-operative instructions" }, TZ));

  // Pilot reminder policy: ONE reminder, 1 hour before a CONFIRMED visit (Settings can change it). The seeded visits were inserted
  // directly, so the plan the confirm action would have made is made here, for the confirmed ones still ahead (FIXTURE sends).
  await ensureNotificationDefaults(db, tenant.id);
  await db.update(notificationRules).set({ enabled: false }).where(and(eq(notificationRules.tenantId, tenant.id), eq(notificationRules.subject, "APPOINTMENT"), eq(notificationRules.kind, "REMINDER"), eq(notificationRules.offsetUnit, "days")));
  const upcoming = await db.select({ id: appointments.id }).from(appointments).where(and(eq(appointments.tenantId, tenant.id), eq(appointments.status, "confirmed"), gt(appointments.scheduledAt, new Date())));
  for (const a of upcoming) await planForSubject(db, tenant.id, "APPOINTMENT", a.id);

  console.log(`Namokar tenant: ${tenant.name} (${tenant.id}) - ${NAMOKAR_JOURNEYS.length} journeys, ${patientRows.length} patients`);
  return { tenantId: tenant.id };
}

/**
 * NAMOKAR V2 PILOT - a clean tenant: configuration and staff ONLY. No patients, journeys, calls, tasks, appointments, treatments,
 * notifications, revenue or conversations, and NO connectors (every provider reads NOT CONFIGURED until the hospital sets it up).
 */
export async function seedNamokarV2Tenant(passwordHash: string) {
  const tenant = await createDemoTenant(NAMOKAR_V2_TENANT_NAME, "BETA_V1_CORE", {
    loginSlug: NAMOKAR_V2_LOGIN_SLUG,
    login: { shortName: "Namokar", tagline: "Every enquiry, call, appointment and follow-up for your patients, in one place.", badgeLabel: "V2 Pilot" },
    clinicHours: NAMOKAR_CLINIC_HOURS,
  });
  await db.insert(tenantCapabilities).values({ tenantId: tenant.id, capability: "REVENUE_TRACKING", enabled: false });
  await installDepartmentTemplate(db, tenant.id, "ophthalmology");
  await keepAddLeadSimple(tenant.id);
  await installPatientIdentityFields(tenant.id);
  const branchByKey = await createDemoBranches(tenant.id, [{ name: "Namokar Eye & Oculoplasty Centre", city: "Ashok Vihar, New Delhi" }]);
  await createDemoUsers("namokar-v2", tenant.id, passwordHash, branchByKey, [
    { slug: "superadmin", name: "Namokar Owner (placeholder)", role: "SUPER_ADMIN", branch: "a" },
    { slug: "admin", name: "Namokar Admin (placeholder)", role: "HOSPITAL_ADMIN", branch: "a" },
    { slug: "doctor", name: "Dr. Poonam Jain", role: "DOCTOR", branch: "a" },
    { slug: "frontdesk", name: "Front Desk", role: "FRONT_DESK", branch: "a" },
    { slug: "shivani", name: "Shivani", role: "PATIENT_COORDINATOR", branch: "a" },
    { slug: "sushil", name: "Sushil", role: "PATIENT_COORDINATOR", branch: "a" },
  ]);
  await ensureDefaultOutcomes(db, tenant.id);
  await ensureFollowUpTypes(db, tenant.id);
  await addPhotoRequestFollowUp(tenant.id);
  // Same reminder policy as V1: ONE reminder, 1 hour before a confirmed visit (the 1-day reminder is off).
  await ensureNotificationDefaults(db, tenant.id);
  await db.update(notificationRules).set({ enabled: false }).where(and(eq(notificationRules.tenantId, tenant.id), eq(notificationRules.subject, "APPOINTMENT"), eq(notificationRules.kind, "REMINDER"), eq(notificationRules.offsetUnit, "days")));
  console.log(`Namokar V2 tenant: ${tenant.name} (${tenant.id}) - configuration only`);
  return { tenantId: tenant.id };
}

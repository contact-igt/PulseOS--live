import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import { dayKeyIn, diffDays, isRealDate, localToday, parseInstant } from "../../lib/hospital-time.js";
import { resolveReportRange, ReportInputError } from "../report/report-period.js";
import { computeLeadsWorkspace, type LeadFact } from "./lead-views.js";
import type { Db } from "../../db/client.js";
import {
  appointments,
  branches,
  campaignTouchpoints,
  crmOutcomes,
  customFieldValues,
  followUpTypes,
  journeys,
  leadSources,
  marketingCampaigns,
  patients,
  specialtyTemplates,
  tasks,
  timelineEvents,
  treatmentOpportunities,
  users,
  customFieldDefinitions,
} from "../../db/schema.js";
import { normalizePhone, resolveDefaultPhoneRegion } from "../patient/phone.js";
import { resolveOrCreatePatient } from "../patient/identity.service.js";
import { loadOperationalStatuses } from "../journey/operational-status.service.js";
import { resolveLeadSource } from "./lead-source.service.js";
import { isValidPastDate, MAX_AGE_YEARS } from "../../lib/age.js";
import { recordTouchpoint } from "../acquisition/attribution.service.js";
import { createFollowUp, createTask, eligibleAssignee } from "../task/task.service.js";
import { createAppointment } from "../appointment/appointment.service.js";
import { logManualCall } from "../call/call.service.js";
import { ensureDefaultOutcomes, logInteraction } from "../crm/crm-outcome.service.js";
import { ensureFollowUpTypes } from "../task/followup-type.service.js";
import { listFieldsForEntry, resolveSubmittedValues } from "../crm/crm-field.service.js";
import { pickOwnerForNewJourney } from "../crm/crm-allocation.service.js";
import type { OwnerFilter } from "../journey/journey.service.js";
import { canRoleSeeField, type FieldVisibility, FOLLOW_UP_KEYS, INTERACTION_CHANNEL_LABEL, MANUAL_INTERACTION_CHANNELS, type CreateLeadInput, type LeadSaveStep, CreateLeadResult, LeadPhoneLookupResult, LeadRow, LeadStatus, LeadsSummary, LeadsWorkspace, LeadsWorkspaceQuery, Role, TASK_TYPE_LABEL } from "@pulseos/types";

export async function lookupPatientByPhone(db: Db, tenantId: string, rawPhone: string): Promise<LeadPhoneLookupResult> {
  const defaultRegion = await resolveDefaultPhoneRegion(db, tenantId);
  const normalized = normalizePhone(rawPhone, defaultRegion);
  if (!normalized.e164) return { patient: null };

  const [patient] = await db
    .select({ id: patients.id, name: patientNameSql, phone: patients.phone })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.phoneE164, normalized.e164)))
    .limit(1);
  if (!patient) return { patient: null };

  const journeyRows = await db.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.patientId, patient.id), ne(journeys.stage, "lost")));
  return { patient: { id: patient.id, name: patient.name, phone: patient.phone, activeJourneyCount: journeyRows.length } };
}

export type CreateLeadOutcome = CreateLeadResult | { validationError: true; missingRequiredFields: string[]; invalidFields: string[] } | { stepError: { step: LeadSaveStep; reason: string } };

/** A child step of the intake refused the save: the whole lead is rolled back and the step is named. */
class LeadStepError extends Error {
  constructor(readonly step: LeadSaveStep, readonly reason: string) {
    super(`${step}: ${reason}`);
  }
}

/** How the first contact is described on the Timeline: honest about being typed in by staff, never a provider message. */
function manualCaptureNote(channel: NonNullable<CreateLeadInput["channel"]>): string {
  if (channel === "MANUAL_CALL") return "Phone call recorded manually";
  if (channel === "WALK_IN") return "Walk-in recorded manually";
  return `${INTERACTION_CHANNEL_LABEL[channel]} manually captured`;
}

/**
 * Add Lead in ONE transaction: patient (found or created) → journey → first contact on the Timeline → manual call →
 * outcome → follow-up task (the M5 engine) or appointment (the M6 booking rules) → custom fields. If any step refuses,
 * everything is rolled back — no half-saved lead, no orphan patient — and the failing step and reason are returned.
 * Appointment events are published only after the commit.
 */
export async function createLead(db: Db, tenantId: string, actorId: string, input: CreateLeadInput, actorRole: Role = "HOSPITAL_ADMIN", timezone = "Asia/Kolkata", now: Date = new Date()): Promise<CreateLeadOutcome> {
  const afterCommit: (() => void)[] = [];
  try {
    const out = await db.transaction((tx) => createLeadIn(tx as unknown as Db, tenantId, actorId, input, actorRole, timezone, now, (publish) => afterCommit.push(publish)));
    if (!("validationError" in out)) for (const publish of afterCommit) publish();
    if (!("validationError" in out) && !("stepError" in out)) {
      emitIntegrationEvent({ type: "lead.created", tenantId, eventId: `lead.created:${out.journeyId}`, occurredAt: now, data: { patientId: out.patientId, journeyId: out.journeyId, isNewPatient: out.isNewPatient, sourceKey: input.sourceKey ?? input.source ?? null } });
    }
    return out;
  } catch (err) {
    if (err instanceof LeadStepError) return { stepError: { step: err.step, reason: err.reason } };
    throw err;
  }
}

async function createLeadIn(db: Db, tenantId: string, actorId: string, input: CreateLeadInput, actorRole: Role, timezone: string, now: Date, afterCommit: (publish: () => void) => void): Promise<CreateLeadOutcome> {
  // Intake basics. All validated before any write.
  const invalid: string[] = [];
  const todayKey = dayKeyIn(now, timezone);
  if (input.dateOfBirth !== undefined && !isValidPastDate(input.dateOfBirth, todayKey)) invalid.push("dateOfBirth");
  if (input.age !== undefined && (!Number.isInteger(input.age) || input.age < 0 || input.age > MAX_AGE_YEARS)) invalid.push("age");
  if (input.channel !== undefined && !MANUAL_INTERACTION_CHANNELS.includes(input.channel)) invalid.push("channel");
  // The first follow-up must be creatable, or the lead is refused up front — never saved without the follow-up it promised.
  if (input.followUp) {
    const owner = input.followUp.assignedTo ?? input.ownerId;
    if (Number.isNaN(new Date(input.followUp.dueAt).getTime()) || (owner && !(await eligibleAssignee(db, tenantId, owner)))) invalid.push("followUp");
  }
  // Next step: a hospital wall time ("2026-10-03T11:00") or an absolute instant, never the server's zone.
  const step = input.nextStep;
  if (step && input.followUp) invalid.push("nextStep");
  let stepAt: Date | null = null;
  if (step && (step.kind === "callback" || step.kind === "follow_up")) stepAt = parseInstant(step.dueAt, timezone);
  if (step && step.kind === "appointment") stepAt = parseInstant(step.scheduledAt, timezone);
  if (step && step.kind !== "none" && !stepAt) invalid.push("nextStep");
  if (step && step.kind === "appointment" && !step.doctorId) invalid.push("nextStep");
  if (input.call && input.channel !== "MANUAL_CALL") invalid.push("call");
  // Everything a client points at must belong to THIS hospital: a foreign owner, branch or campaign is refused up front,
  // never stored and never turned into a task assigned to someone else's staff.
  if (input.ownerId && !(await eligibleAssignee(db, tenantId, input.ownerId))) invalid.push("ownerId");
  if (input.branchId) {
    const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId))).limit(1);
    if (!b) invalid.push("branchId");
  }
  if (input.campaignId) {
    const [c] = await db.select({ id: marketingCampaigns.id }).from(marketingCampaigns).where(and(eq(marketingCampaigns.tenantId, tenantId), eq(marketingCampaigns.id, input.campaignId))).limit(1);
    if (!c) invalid.push("campaignId");
  }

  // SOURCE (where the patient originally came from). A person picks from the hospital's offered sources; the
  // legacy coarse value is still accepted for older callers and resolves even to an archived entry.
  const source = input.sourceKey
    ? await resolveLeadSource(db, tenantId, input.sourceKey, { allowArchived: false })
    : input.source
      ? await resolveLeadSource(db, tenantId, input.source, { allowArchived: true })
      : null;
  if (!source) {
    return { validationError: true, missingRequiredFields: input.sourceKey || input.source ? [] : ["source"], invalidFields: [...invalid, ...(input.sourceKey || input.source ? ["source"] : [])] };
  }
  if (invalid.length > 0) return { validationError: true, missingRequiredFields: [], invalidFields: invalid };

  // The outcome and the next step must agree, checked before anything is written.
  let outcome: typeof crmOutcomes.$inferSelect | null = null;
  if (input.outcomeKey) {
    await ensureDefaultOutcomes(db, tenantId);
    [outcome = null] = await db.select().from(crmOutcomes).where(and(eq(crmOutcomes.tenantId, tenantId), eq(crmOutcomes.key, input.outcomeKey), eq(crmOutcomes.archived, false))).limit(1);
    if (!outcome) throw new LeadStepError("outcome", "outcome_not_found");
    const kind = step?.kind ?? "none";
    if (outcome.stage === "lost" && (kind !== "none" || input.followUp)) throw new LeadStepError("outcome", "outcome_closes_journey");
    if (outcome.requiresFollowUp && kind !== "callback" && kind !== "follow_up") throw new LeadStepError("outcome", "follow_up_required");
    if (kind === "appointment" && !outcome.allowsAppointment) throw new LeadStepError("outcome", "outcome_disallows_appointment");
  }

  // Required-field enforcement happens before any write — server-side, not
  // just the Add Lead form's `required` attribute, so an API call that
  // bypasses the UI can't silently skip data Settings marked mandatory.
  // The fields on this form are the ones configured for Add Lead in this service scope, not
  // archived, and visible to the person submitting. Values are validated by field type.
  const entryFields = await listFieldsForEntry(db, tenantId, actorRole, { placement: "add_lead", specialtyKey: input.specialtyKey });
  const submitted = resolveSubmittedValues(entryFields, input.customFieldValues, { outcomeKey: input.outcomeKey ?? null });
  if (!submitted.ok) {
    return { validationError: true, missingRequiredFields: submitted.missing, invalidFields: submitted.invalid };
  }

  // Canonical duplicate-prevention check: always resolve by phone through
  // the one shared identity path, never trust a client-supplied patientId
  // blindly — a stale hint must not create a duplicate identity, and a
  // match must not be ignored.
  const { patient, isNewPatient } = await resolveOrCreatePatient(db, {
    tenantId,
    phone: input.phone,
    name: input.name,
    dateOfBirth: input.dateOfBirth,
    reportedAge: input.age,
    email: input.email,
    preferredLanguage: input.preferredLanguage,
    branchId: input.branchId,
  });
  const patientId = patient.id;

  if (isNewPatient) {
    await db.insert(timelineEvents).values({
      tenantId,
      patientId,
      actorType: "user",
      actorId,
      eventType: "patient_created",
      title: "Patient created",
      sourceChannel: source.key,
    });
  }

  const [service] = await db.select({ departmentId: specialtyTemplates.departmentId }).from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, input.specialtyKey))).limit(1);

  // Nobody chosen: the first matching allocation rule (Settings → Allocation Rules) picks the owner.
  const allocated = input.ownerId ? null : await pickOwnerForNewJourney(db, tenantId, { source: source.bucket, specialtyKey: input.specialtyKey, journeyType: input.journeyType, branchId: input.branchId });
  const [journey] = await db
    .insert(journeys)
    .values({
      tenantId,
      patientId,
      journeyType: input.journeyType,
      specialtyKey: input.specialtyKey,
      source: source.bucket,
      sourceId: source.id,
      departmentId: service?.departmentId ?? null,
      ownerUserId: input.ownerId ?? allocated?.userId ?? null,
      priority: input.priority ?? "normal",
      notes: input.notes ?? null,
    })
    .returning();

  if (allocated) {
    await db.insert(timelineEvents).values({
      tenantId, patientId, journeyId: journey.id, actorType: "system", eventType: "journey_auto_assigned",
      title: `Auto-assigned to ${allocated.userName}`, description: `Allocation rule: ${allocated.ruleName}`,
    });
  }

  if (input.campaignId) {
    // Journey-scoped attribution (first touch immutable, later touches
    // become last_touch, full history preserved) rather than always writing
    // first_touch — see acquisition/attribution.service.ts. A brand-new
    // Journey has no prior touchpoints, so this call is always the first
    // touch for it; the first/last distinction only becomes visible once a
    // second touch is recorded against the same still-open Journey (e.g. by
    // a future adapter's webhook, or a subsequent Add Lead call that
    // resolves to this Journey).
    await recordTouchpoint(db, {
      tenantId,
      patientId,
      journeyId: journey.id,
      details: { source: source.bucket, occurredAt: new Date() },
      campaignId: input.campaignId,
    });
  }

  for (const { field, value } of submitted.values) {
    await db.insert(customFieldValues).values({ tenantId, journeyId: journey.id, fieldDefinitionId: field.id, value });
  }

  const ownerId = journey.ownerUserId;
  const ownerName = ownerId ? ((await db.select({ name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, ownerId))).limit(1))[0]?.name ?? null) : null;
  await db.insert(timelineEvents).values({
    tenantId,
    patientId,
    journeyId: journey.id,
    actorType: "user",
    actorId,
    eventType: "lead_created",
    title: `Lead created — ${input.journeyType}`,
    // Honest: staff typed this in. No provider message, call or conversation is invented from the channel. The line says what the
    // journey starts from - where the person came from and who looks after it (the service is already in the title) - so the first event reads as the start.
    description: [`Source: ${source.label}`, ownerName ? `Assigned to ${ownerName}` : null, input.channel ? manualCaptureNote(input.channel) : null].filter(Boolean).join(" · "),
    sourceChannel: source.key,
    // How this first contact happened, when staff said. Never inferred from the source.
    channel: input.channel ?? null,
  });

  if (input.followUp) {
    const made = await createTask(db, tenantId, actorId, {
      patientId,
      journeyId: journey.id,
      assignedTo: input.followUp.assignedTo ?? input.ownerId,
      type: input.followUp.type,
      dueAt: input.followUp.dueAt,
    }, timezone);
    if (!made.ok) throw new LeadStepError("follow_up", made.reason);
  }

  const result: CreateLeadResult = { patientId, journeyId: journey.id, isNewPatient };
  const actor = { id: actorId, role: actorRole };

  // Phone enquiry with call details: the M4 manual call log (a Call row + Timeline line). No outcome or callback here —
  // those are handled once, below, so a call can never create a second task.
  if (input.call) {
    const [who] = await db.select({ name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, actorId))).limit(1);
    const logged = await logManualCall(db, tenantId, { ...actor, name: who?.name ?? "Staff" }, journey.id, { direction: input.call.direction, connected: input.call.connected, durationSeconds: input.call.durationSeconds, staffFeedback: input.call.note }, now, timezone);
    if (!logged.ok) throw new LeadStepError("call", logged.reason);
    result.callId = logged.callId;
    // Staff actually spoke to the patient: the lead is contacted, whether or not an outcome is recorded below.
    if (input.call.connected) await db.update(journeys).set({ stage: "contacted", contactedAt: now }).where(and(eq(journeys.id, journey.id), eq(journeys.stage, "enquiry")));
  }

  const followUpKind = step && (step.kind === "callback" || step.kind === "follow_up") ? step : null;

  if (outcome) {
    const logged = await logInteraction(
      db,
      tenantId,
      actor,
      journey.id,
      { outcomeKey: outcome.key, note: input.outcomeNote, reason: input.outcomeReason, channel: input.channel, ...(outcome.requiresFollowUp && stepAt ? { followUpAt: stepAt.toISOString() } : {}) },
      now,
      timezone,
      { skipFollowUpTask: true },
    );
    if (!logged.ok) throw new LeadStepError(logged.reason === "follow_up_in_past" ? "follow_up" : "outcome", logged.reason === "follow_up_in_past" ? "due_in_past" : logged.reason);
  }

  if (followUpKind && stepAt) {
    const key = followUpKind.kind === "callback" ? FOLLOW_UP_KEYS.callback : FOLLOW_UP_KEYS.general;
    const [type] = await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.key, key), eq(followUpTypes.isActive, true))).limit(1);
    // Install the defaults on first use, then look again: a brand-new hospital has none yet.
    const typeId = type?.id ?? (await ensureFollowUpTypes(db, tenantId), (await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.key, key), eq(followUpTypes.isActive, true))).limit(1))[0]?.id);
    if (!typeId) throw new LeadStepError("follow_up", "type_invalid");
    const made = await createFollowUp(db, tenantId, { id: actorId }, journey.id, { followUpTypeId: typeId, dueAt: stepAt.toISOString(), note: followUpKind.note, ...(followUpKind.assignedTo ? { assignedTo: followUpKind.assignedTo } : {}) }, timezone, now);
    if (!made.ok) throw new LeadStepError("follow_up", made.reason);
    result.followUpTaskId = made.task.id;
  }

  if (step && step.kind === "appointment" && stepAt) {
    const booked = await createAppointment(db, tenantId, actorId, { patientId, journeyId: journey.id, branchId: step.branchId ?? input.branchId, doctorId: step.doctorId, scheduledAt: stepAt.toISOString(), reason: step.note?.trim() || "Consultation" }, timezone, now, afterCommit);
    if (!booked.ok) throw new LeadStepError("appointment", booked.reason);
    result.appointmentId = booked.appointment.id;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Leads workspace — a VIEW over journeys/patients/tasks/appointments, not a
// separate workflow-state system. leadStatus is derived from existing
// stage/contactedAt/task/appointment/treatment data, never stored.
// ---------------------------------------------------------------------------

export interface LeadFilters {
  status?: LeadStatus;
  specialtyKey?: string;
  source?: string;
  owner?: OwnerFilter;
}

async function buildLeadFacts(db: Db, tenantId: string, timezone: string, now: Date = new Date()): Promise<LeadFact[]> {
  const today = dayKeyIn(now, timezone);
  const rows = await db
    .select({
      id: journeys.id,
      patientId: journeys.patientId,
      patientName: patientNameSql,
      phone: patients.phone,
      specialtyKey: journeys.specialtyKey,
      source: journeys.source,
      sourceLabel: leadSources.label,
      sourceKey: leadSources.key,
      stage: journeys.stage,
      priority: journeys.priority,
      contactedAt: journeys.contactedAt,
      ownerId: journeys.ownerUserId,
      createdAt: journeys.createdAt,
      ownerName: users.name,
      journeyType: journeys.journeyType,
      outcomeLabel: crmOutcomes.label,
    })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .leftJoin(users, and(eq(journeys.ownerUserId, users.id), eq(users.tenantId, tenantId)))
    .leftJoin(leadSources, eq(journeys.sourceId, leadSources.id))
    .leftJoin(crmOutcomes, eq(journeys.lastOutcomeId, crmOutcomes.id))
    .where(eq(journeys.tenantId, tenantId));

  const specialties = await db.select({ key: specialtyTemplates.key, displayName: specialtyTemplates.displayName }).from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, tenantId));
  const specialtyLabelByKey = new Map(specialties.map((s) => [s.key, s.displayName]));

  const campaignTouchpointRows = await db
    .select({ journeyId: campaignTouchpoints.journeyId, campaignId: campaignTouchpoints.campaignId })
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.tenantId, tenantId), eq(campaignTouchpoints.touchType, "first_touch")));
  const campaignByJourney = new Map(campaignTouchpointRows.map((c) => [c.journeyId, c.campaignId]));

  const campaignRows = await db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId));
  const campaignNameById = new Map(campaignRows.map((c) => [c.id, c.name]));

  const apptRows = await db
    .select({ id: appointments.id, journeyId: appointments.journeyId, status: appointments.status, scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .where(and(eq(appointments.tenantId, tenantId), ne(appointments.status, "cancelled"), ne(appointments.status, "no_show")));
  const journeysWithAppointment = new Set(apptRows.map((a) => a.journeyId));
  const PENDING_VISIT = ["requested", "scheduled", "confirmed"];
  const IN_CLINIC_OR_PENDING = [...PENDING_VISIT, "checked_in", "waiting", "with_doctor"];
  const appointmentDaysByJourney = new Map<string, string[]>();
  const bookedPending = new Set<string>();
  const nextApptByJourney = new Map<string, { id: string; at: Date; status: string }>();
  for (const a of apptRows) {
    if (!a.journeyId) continue;
    const day = dayKeyIn(a.scheduledAt, timezone);
    appointmentDaysByJourney.set(a.journeyId, [...(appointmentDaysByJourney.get(a.journeyId) ?? []), day]);
    if (PENDING_VISIT.includes(a.status)) bookedPending.add(a.journeyId);
    if (IN_CLINIC_OR_PENDING.includes(a.status) && day >= today) {
      const cur = nextApptByJourney.get(a.journeyId);
      if (!cur || a.scheduledAt < cur.at) nextApptByJourney.set(a.journeyId, { id: a.id, at: a.scheduledAt, status: a.status });
    }
  }

  const treatmentRows = await db
    .select({ journeyId: treatmentOpportunities.journeyId, status: treatmentOpportunities.status })
    .from(treatmentOpportunities)
    .where(and(eq(treatmentOpportunities.tenantId, tenantId), or(eq(treatmentOpportunities.status, "ACCEPTED"), eq(treatmentOpportunities.status, "COMPLETED"))));
  const journeysConverted = new Set(treatmentRows.map((t) => t.journeyId));

  const pendingTaskRows = await db
    .select({ journeyId: tasks.journeyId, dueAt: tasks.dueAt, type: tasks.type, followUpLabel: followUpTypes.label })
    .from(tasks)
    .leftJoin(followUpTypes, eq(tasks.followUpTypeId, followUpTypes.id))
    .where(and(eq(tasks.tenantId, tenantId), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress"))));
  const nextTaskByJourney = new Map<string, Date>();
  const nextTaskLabel = new Map<string, string>();
  const taskInstants = new Map<string, number[]>();
  const taskDays = new Map<string, string[]>();
  for (const t of pendingTaskRows) {
    if (!t.journeyId) continue;
    const existing = nextTaskByJourney.get(t.journeyId);
    if (!existing || t.dueAt < existing) {
      nextTaskByJourney.set(t.journeyId, t.dueAt);
      nextTaskLabel.set(t.journeyId, t.followUpLabel ?? TASK_TYPE_LABEL[t.type] ?? "Follow-up");
    }
    taskInstants.set(t.journeyId, [...(taskInstants.get(t.journeyId) ?? []), t.dueAt.getTime()]);
    taskDays.set(t.journeyId, [...(taskDays.get(t.journeyId) ?? []), dayKeyIn(t.dueAt, timezone)]);
  }

  const lastEventRows = await db.select({ journeyId: timelineEvents.journeyId, occurredAt: timelineEvents.occurredAt }).from(timelineEvents).where(eq(timelineEvents.tenantId, tenantId));
  const lastInteractionByJourney = new Map<string, Date>();
  for (const e of lastEventRows) {
    if (!e.journeyId) continue;
    const existing = lastInteractionByJourney.get(e.journeyId);
    if (!existing || e.occurredAt > existing) lastInteractionByJourney.set(e.journeyId, e.occurredAt);
  }

  const operational = await loadOperationalStatuses(db, tenantId, rows.map((r) => ({ id: r.id, stage: r.stage })));

  return rows.map((r): LeadFact => {
    let leadStatus: LeadStatus;
    if (r.stage === "lost") {
      leadStatus = "lost";
    } else if (journeysConverted.has(r.id) || r.stage === "completed") {
      leadStatus = "converted";
    } else if (journeysWithAppointment.has(r.id)) {
      leadStatus = "appointment_booked";
    } else if (!r.contactedAt) {
      leadStatus = dayKeyIn(r.createdAt, timezone) === today ? "new" : "uncontacted";
    } else if (nextTaskByJourney.has(r.id)) {
      leadStatus = "follow_up_due";
    } else {
      leadStatus = "no_response";
    }

    const campaignId = campaignByJourney.get(r.id) ?? null;

    const row: LeadRow = {
      id: r.id,
      patientId: r.patientId,
      patientName: r.patientName,
      phone: r.phone,
      specialtyKey: r.specialtyKey,
      specialtyLabel: r.specialtyKey ? (specialtyLabelByKey.get(r.specialtyKey) ?? r.specialtyKey) : null,
      source: r.source,
      sourceLabel: r.sourceLabel ?? r.source,
      campaignName: campaignId ? (campaignNameById.get(campaignId) ?? null) : null,
      stage: r.stage,
      leadStatus,
      operationalStatus: operational.get(r.id) ?? null,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      priority: r.priority,
      lastInteractionAt: (lastInteractionByJourney.get(r.id) ?? r.createdAt).toISOString(),
      nextActionDueAt: nextTaskByJourney.get(r.id)?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      journeyType: r.journeyType,
      outcomeLabel: r.outcomeLabel ?? null,
      nextAction: nextTaskByJourney.has(r.id) ? { label: nextTaskLabel.get(r.id)!, dueAt: nextTaskByJourney.get(r.id)!.toISOString(), overdue: nextTaskByJourney.get(r.id)!.getTime() < now.getTime() } : null,
      nextAppointment: nextApptByJourney.has(r.id) ? { id: nextApptByJourney.get(r.id)!.id, at: nextApptByJourney.get(r.id)!.at.toISOString(), status: nextApptByJourney.get(r.id)!.status } : null,
    };
    return {
      row,
      createdDay: dayKeyIn(r.createdAt, timezone),
      openTaskDueAts: taskInstants.get(r.id) ?? [],
      openTaskDays: taskDays.get(r.id) ?? [],
      appointmentDays: appointmentDaysByJourney.get(r.id) ?? [],
      bookedPending: bookedPending.has(r.id),
      sourceKey: r.sourceKey ?? null,
    };
  });
}

async function buildLeadRows(db: Db, tenantId: string, timezone: string): Promise<LeadRow[]> {
  return (await buildLeadFacts(db, tenantId, timezone)).map((f) => f.row);
}

export async function listLeads(db: Db, tenantId: string, filters: LeadFilters, timezone: string): Promise<LeadRow[]> {
  const rows = await buildLeadRows(db, tenantId, timezone);
  return rows
    .filter((r) => !filters.status || r.leadStatus === filters.status)
    .filter((r) => !filters.specialtyKey || r.specialtyKey === filters.specialtyKey)
    .filter((r) => !filters.source || r.source === filters.source)
    .filter((r) => !filters.owner || (filters.owner.kind === "unassigned" ? r.ownerId === null : r.ownerId === filters.owner.userId));
}

export async function getLeadsSummary(db: Db, tenantId: string, timezone: string): Promise<LeadsSummary> {
  const rows = await buildLeadRows(db, tenantId, timezone);
  const count = (status: LeadStatus) => rows.filter((r) => r.leadStatus === status).length;
  return {
    newToday: count("new"),
    uncontacted: count("uncontacted"),
    followUpsDue: count("follow_up_due"),
    appointmentsBooked: count("appointment_booked"),
    noResponse: count("no_response"),
    converted: count("converted"),
  };
}


/**
 * Presets are the report's (hospital calendar days). A custom range may reach into the future — tomorrow's callbacks
 * are exactly what Follow-up Due is for — but must be a real, ordered pair no longer than a year.
 */
function resolveLeadRange(range: NonNullable<LeadsWorkspaceQuery["range"]>, today: string, from?: string, to?: string): { from: string; to: string } {
  if (range !== "custom") return resolveReportRange(range, today);
  if (!from || !to || !isRealDate(from) || !isRealDate(to)) throw new ReportInputError("A custom range needs valid from and to dates (YYYY-MM-DD)");
  if (diffDays(from, to) < 0) throw new ReportInputError("'from' must not be after 'to'");
  if (diffDays(from, to) + 1 > 366) throw new ReportInputError("A range can cover at most 366 days");
  return { from, to };
}

/**
 * The Leads workspace in one round trip: the rows of the chosen quick view, the count of every view under the same
 * filters, the compact "today" strip and per-owner counts. All days are hospital-local (tenants.timezone).
 * `owner` accepts mine | unassigned | <userId>, "mine" being the SESSION user (resolved by the route).
 */
export async function getLeadsWorkspace(db: Db, tenantId: string, query: Omit<LeadsWorkspaceQuery, "owner"> & { owner?: OwnerFilter }, timezone: string, now: Date = new Date(), role?: Role): Promise<LeadsWorkspace> {
  const today = await localToday(db, timezone, now);
  const hasRange = !!query.range && !(query.range === "custom" && !query.from);
  const range = query.range ? resolveLeadRange(query.range, today, query.from, query.to) : undefined;
  let facts = await buildLeadFacts(db, tenantId, timezone, now);
  // A "filterable" CRM field narrows the list to journeys whose recorded answer matches (only fields the hospital marked so).
  const { options: fieldOptions, matchingJourneyIds } = await filterableFieldSupport(db, tenantId, role, query.fieldKey, query.fieldValue);
  if (matchingJourneyIds) facts = facts.filter((f) => matchingJourneyIds.has(f.row.id));
  const result = computeLeadsWorkspace(facts, {
    view: query.view,
    today,
    now,
    range: hasRange ? range : undefined,
    owner: query.owner,
    source: query.source,
    service: query.service,
    status: query.status,
    due: query.due,
  });
  return { ...result, options: { ...result.options, filterableFields: fieldOptions }, period: { range: query.range ?? null, from: range?.from ?? null, to: range?.to ?? null, today, timezone } };
}

/** The filterable CRM fields (deduped by key, choice / Yes-No only) and, when one is applied, the journeys that match it. */
async function filterableFieldSupport(db: Db, tenantId: string, role: Role | undefined, fieldKey?: string, fieldValue?: string): Promise<{ options: LeadsWorkspace["options"]["filterableFields"]; matchingJourneyIds: Set<string> | null }> {
  // Only fields this role may see: a hidden clinical field must not be inferable through the filter either (no role → "everyone" only).
  const defs = (await db.select().from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.filterable, true), eq(customFieldDefinitions.archived, false)))).filter((d) =>
    role ? canRoleSeeField(role, d.visibleTo as FieldVisibility) : d.visibleTo === "everyone",
  );
  const byKey = new Map<string, { key: string; label: string; options: string[] }>();
  for (const d of defs) {
    if (byKey.has(d.key)) continue;
    const opts = d.fieldType === "BOOLEAN" ? ["true", "false"] : d.fieldType === "SELECT" || d.fieldType === "MULTI_SELECT" ? ((d.options as string[] | null) ?? []) : null;
    if (opts) byKey.set(d.key, { key: d.key, label: d.label, options: opts });
  }
  const options = [...byKey.values()];
  if (!fieldKey || fieldValue === undefined || !byKey.has(fieldKey)) return { options, matchingJourneyIds: null };
  const visibleIds = defs.filter((d) => d.key === fieldKey).map((d) => d.id);
  const rows = await db.execute<{ journey_id: string }>(sql`
    select v.journey_id from custom_field_values v join custom_field_definitions d on d.id = v.field_definition_id
    where d.tenant_id = ${tenantId} and d.id in (${sql.join(visibleIds.map((id) => sql`${id}`), sql`, `)})
      and ((jsonb_typeof(v.value) = 'array' and v.value ? ${fieldValue}) or (jsonb_typeof(v.value) <> 'array' and (v.value #>> '{}') = ${fieldValue}))`);
  return { options, matchingJourneyIds: new Set([...rows].map((r) => r.journey_id)) };
}

export { ReportInputError as LeadRangeError };

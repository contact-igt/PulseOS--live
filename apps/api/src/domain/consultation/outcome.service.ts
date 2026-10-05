import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, consultationOutcomes, followUpTypes, journeys, tasks, timelineEvents, treatmentOpportunities } from "../../db/schema.js";
import { FOLLOW_UP_KEYS, type ConsultationOutcomeValue, type Role } from "@pulseos/types";
import { addDays, dayKeyIn, tenantTimezone, zonedWallTime } from "../../lib/hospital-time.js";
import { findActiveTreatmentDefinition } from "../specialty/treatment-catalog.service.js";
import { createFollowUp } from "../task/task.service.js";
import { ensureFollowUpTypes } from "../task/followup-type.service.js";

export interface RecordOutcomeParams {
  tenantId: string;
  appointmentId: string;
  doctorUserId: string;
  /** The recorder's role. A Doctor may only record on a visit that is with them. Absent = no ownership rule (internal callers). */
  actorRole?: Role;
  outcome: ConsultationOutcomeValue;
  notes?: string;
  treatmentLabel?: string;
  /** Catalog procedure; must be an active entry of params.tenantId's catalog. Wins over treatmentLabel. */
  treatmentDefinitionId?: string;
  estimatedValue?: number;
}

const STAGE_BY_OUTCOME: Partial<Record<ConsultationOutcomeValue, (typeof journeys.stage.enumValues)[number]>> = {
  CONSULTED: "consulted",
  NO_TREATMENT_REQUIRED: "consulted",
  FOLLOW_UP_REQUIRED: "consulted",
  DECISION_PENDING: "consulted",
  REFERRED: "consulted",
  TREATMENT_DECLINED: "consulted",
  TREATMENT_ADVISED: "treatment_advised",
};

/** A treatment that is still a live decision or commitment: recording the same advice again must reuse it, not duplicate it. */
const OPEN_TREATMENT = ["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED"] as const;
/** What the patient may still say no to (the state machine only allows DECLINED from these). */
const DECLINABLE = ["ADVISED", "DECISION_PENDING"] as const;

const DEFAULT_FOLLOW_UP_DAYS = 3;
const DECISION_FOLLOW_UP_DAYS = 2;

/**
 * Records the ONE operational outcome of a completed consultation and does what that outcome means, reusing what already
 * exists instead of duplicating it:
 *   no treatment      -> nothing further
 *   review/follow-up  -> one open follow-up task (an existing open one is reused)
 *   procedure advised -> a Treatment Opportunity (an open one for the same procedure is reused)
 *   patient deciding  -> the opportunity AND one treatment-decision follow-up (reused if already open)
 *   declined          -> the open opportunity is DECLINED (or the declined procedure is recorded); no follow-up is invented
 * "Procedure scheduled" is not an outcome: scheduling goes through the existing surgery flow. This is a workflow record, not a
 * clinical one: no diagnosis, prescription or clinical notes are stored here.
 */
export async function recordConsultationOutcome(db: Db, params: RecordOutcomeParams) {
  const [appointment] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.tenantId, params.tenantId), eq(appointments.id, params.appointmentId)))
    .limit(1);
  if (!appointment) return { ok: false as const, reason: "appointment_not_found" as const };
  // A doctor records only for their own patients; Super Admin (the only other role allowed) may record for any.
  if (params.actorRole === "DOCTOR" && appointment.doctorUserId !== params.doctorUserId) return { ok: false as const, reason: "forbidden" as const };
  // An outcome is the result of a consultation that happened.
  if (appointment.status !== "completed") return { ok: false as const, reason: "appointment_not_completed" as const };

  // Validated before anything is written: an unknown, inactive or other-tenant definition is a 422, never a partial outcome.
  const definition = params.treatmentDefinitionId ? await findActiveTreatmentDefinition(db, params.tenantId, params.treatmentDefinitionId) : null;
  if (params.treatmentDefinitionId && !definition) return { ok: false as const, reason: "invalid_treatment_definition" as const };

  const [existing] = await db
    .select({ id: consultationOutcomes.id })
    .from(consultationOutcomes)
    .where(eq(consultationOutcomes.appointmentId, params.appointmentId))
    .limit(1);
  if (existing) return { ok: false as const, reason: "outcome_already_recorded" as const };

  const [outcome] = await db
    .insert(consultationOutcomes)
    .values({
      tenantId: params.tenantId,
      patientId: appointment.patientId,
      journeyId: appointment.journeyId,
      appointmentId: appointment.id,
      outcome: params.outcome,
      recordedBy: params.doctorUserId,
      notes: params.notes,
    })
    .returning();

  const nextStage = STAGE_BY_OUTCOME[params.outcome];
  if (nextStage) {
    await db.update(journeys).set({ stage: nextStage }).where(eq(journeys.id, appointment.journeyId));
  }

  const [journey] = await db.select().from(journeys).where(and(eq(journeys.id, appointment.journeyId), eq(journeys.tenantId, params.tenantId))).limit(1);
  const timezone = await tenantTimezone(db, params.tenantId);
  const wantedLabel = definition?.label ?? params.treatmentLabel?.trim() ?? null;

  /** An open opportunity for the same procedure (by catalog entry, else by label; with no name given, any open one). */
  const findOpenTreatment = async (statuses: readonly (typeof OPEN_TREATMENT)[number][]) => {
    const rows = await db
      .select()
      .from(treatmentOpportunities)
      .where(and(eq(treatmentOpportunities.tenantId, params.tenantId), eq(treatmentOpportunities.journeyId, appointment.journeyId), inArray(treatmentOpportunities.status, [...statuses])));
    return rows.find((r) => (definition ? r.treatmentDefinitionId === definition.id : wantedLabel ? r.treatmentLabel.toLowerCase() === wantedLabel.toLowerCase() : true));
  };

  let treatmentOpportunity: typeof treatmentOpportunities.$inferSelect | null = null;
  let treatmentCreated = false;
  if (params.outcome === "TREATMENT_ADVISED" || params.outcome === "DECISION_PENDING") {
    const reused = await findOpenTreatment(OPEN_TREATMENT);
    if (reused) {
      treatmentOpportunity = reused;
      // An explicit value on a repeat outcome is the doctor's latest word: it replaces the earlier estimate (never a silent default).
      if (params.estimatedValue !== undefined && params.estimatedValue !== reused.estimatedValue) {
        [treatmentOpportunity = reused] = await db.update(treatmentOpportunities).set({ estimatedValue: params.estimatedValue, updatedAt: new Date() }).where(eq(treatmentOpportunities.id, reused.id)).returning();
      }
      // Advice that turns into "the patient is deciding" moves ADVISED forward; anything further along is left as it is.
      if (params.outcome === "DECISION_PENDING" && reused.status === "ADVISED") {
        [treatmentOpportunity = treatmentOpportunity ?? reused] = await db.update(treatmentOpportunities).set({ status: "DECISION_PENDING", updatedAt: new Date() }).where(and(eq(treatmentOpportunities.id, reused.id), eq(treatmentOpportunities.status, "ADVISED"))).returning();
      }
    } else {
      [treatmentOpportunity] = await db
        .insert(treatmentOpportunities)
        .values({
          tenantId: params.tenantId,
          patientId: appointment.patientId,
          journeyId: appointment.journeyId,
          consultationOutcomeId: outcome.id,
          treatmentLabel: wantedLabel ?? "Treatment",
          treatmentDefinitionId: definition?.id ?? null,
          status: params.outcome === "TREATMENT_ADVISED" ? "ADVISED" : "DECISION_PENDING",
          estimatedValue: params.estimatedValue ?? definition?.defaultEstimatedValue ?? 0,
          ownerUserId: journey?.ownerUserId ?? null,
        })
        .returning();
      treatmentCreated = true;
    }
  } else if (params.outcome === "TREATMENT_DECLINED") {
    const open = await findOpenTreatment(DECLINABLE);
    if (open) {
      [treatmentOpportunity] = await db
        .update(treatmentOpportunities)
        .set({ status: "DECLINED", decisionDate: new Date(), updatedAt: new Date() })
        .where(and(eq(treatmentOpportunities.id, open.id), inArray(treatmentOpportunities.status, [...DECLINABLE])))
        .returning();
    } else if (!(await findOpenTreatment(["ACCEPTED", "SCHEDULED"]))) {
      // Nothing was on file: keep the decision visible rather than lose it. (A procedure the patient already accepted or booked
      // is cancelled explicitly on the Treatments page, never by a consultation note.)
      [treatmentOpportunity] = await db
        .insert(treatmentOpportunities)
        .values({
          tenantId: params.tenantId, patientId: appointment.patientId, journeyId: appointment.journeyId, consultationOutcomeId: outcome.id,
          treatmentLabel: wantedLabel ?? "Treatment", treatmentDefinitionId: definition?.id ?? null, status: "DECLINED", decisionDate: new Date(),
          estimatedValue: params.estimatedValue ?? definition?.defaultEstimatedValue ?? 0, ownerUserId: journey?.ownerUserId ?? null,
        })
        .returning();
      treatmentCreated = true;
    }
  }

  // The follow-up this outcome calls for: reuse an open one on the journey, else create exactly one.
  let followUpTask: typeof tasks.$inferSelect | null = null;
  if (params.outcome === "FOLLOW_UP_REQUIRED" || params.outcome === "DECISION_PENDING") {
    const reuseTypes = params.outcome === "FOLLOW_UP_REQUIRED" ? (["FOLLOW_UP", "CALLBACK"] as const) : (["TREATMENT_DECISION"] as const);
    const openTasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, params.tenantId), eq(tasks.journeyId, appointment.journeyId), inArray(tasks.status, ["pending", "in_progress"]), inArray(tasks.type, [...reuseTypes])));
    followUpTask = openTasks.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0] ?? null;

    if (!followUpTask) {
      const days = params.outcome === "FOLLOW_UP_REQUIRED" ? DEFAULT_FOLLOW_UP_DAYS : DECISION_FOLLOW_UP_DAYS;
      const dueAt = zonedWallTime(addDays(dayKeyIn(new Date(), timezone), days), 10, 0, timezone);
      if (params.outcome === "FOLLOW_UP_REQUIRED") {
        await ensureFollowUpTypes(db, params.tenantId);
        const [type] = await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, params.tenantId), eq(followUpTypes.key, FOLLOW_UP_KEYS.appointmentFollowUp), eq(followUpTypes.isActive, true))).limit(1);
        const made = type
          ? await createFollowUp(db, params.tenantId, { id: params.doctorUserId }, appointment.journeyId, { followUpTypeId: type.id, dueAt: dueAt.toISOString(), assignedTo: journey?.ownerUserId ?? null, note: "Review after the consultation" }, timezone)
          : null;
        if (made?.ok) [followUpTask = null] = await db.select().from(tasks).where(eq(tasks.id, made.task.id)).limit(1);
      }
      if (!followUpTask) {
        [followUpTask] = await db
          .insert(tasks)
          .values({
            tenantId: params.tenantId, patientId: appointment.patientId, journeyId: appointment.journeyId, assignedTo: treatmentOpportunity?.ownerUserId ?? journey?.ownerUserId ?? null,
            reason: params.outcome === "DECISION_PENDING" ? "treatment_decision_pending" : "missed_follow_up",
            type: params.outcome === "DECISION_PENDING" ? "TREATMENT_DECISION" : "FOLLOW_UP",
            priority: params.outcome === "DECISION_PENDING" ? "high" : "normal",
            status: "pending", dueAt, createdBy: params.doctorUserId,
            notes: params.outcome === "DECISION_PENDING" ? "Call the patient to help them decide on the advised treatment" : "Review after the consultation",
          })
          .returning();
      }
    }
  }

  const timelineRows: (typeof timelineEvents.$inferInsert)[] = [
    {
      tenantId: params.tenantId,
      patientId: appointment.patientId,
      journeyId: appointment.journeyId,
      actorType: "user",
      actorId: params.doctorUserId,
      eventType: "consultation_outcome_recorded",
      title: `Consultation outcome: ${params.outcome.replace(/_/g, " ").toLowerCase()}`,
      description: params.notes ?? null,
      relatedEntityType: "consultation_outcome",
      relatedEntityId: outcome.id,
      occurredAt: outcome.recordedAt,
    },
  ];
  if (treatmentOpportunity && (treatmentCreated || params.outcome === "TREATMENT_DECLINED")) {
    timelineRows.push({
      tenantId: params.tenantId,
      patientId: appointment.patientId,
      journeyId: appointment.journeyId,
      actorType: "system",
      eventType: "treatment_status_changed",
      title: `Treatment "${treatmentOpportunity.treatmentLabel}" — ${treatmentOpportunity.status.replace(/_/g, " ").toLowerCase()}`,
      relatedEntityType: "treatment_opportunity",
      relatedEntityId: treatmentOpportunity.id,
      occurredAt: new Date(),
    });
  }
  await db.insert(timelineEvents).values(timelineRows);

  return { ok: true as const, outcome, treatmentOpportunity, followUpTask };
}

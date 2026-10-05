import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { crmOutcomes, customFieldValues, journeys, tasks, timelineEvents } from "../../db/schema.js";
import type { CreateCrmOutcomeInput, CrmOutcomeVm, JourneyStage, LogInteractionInput, LogInteractionResult, OutcomeStage, Role, TaskType, UpdateCrmOutcomeInput } from "@pulseos/types";
import { scheduledEvent } from "../task/task.service.js";
import { applyAppointmentAction, createAppointment, resolveBookingTargets } from "../appointment/appointment.service.js";
import { listFieldsForEntry, loadJourneyValuesByKey, resolveSubmittedValues, type Result } from "./crm-field.service.js";

// Configurable outcomes. Canonical stages are fixed (enquiry → contacted → booked → ...); an outcome only
// maps to CONTACTED or LOST, and logging one never moves a Journey backwards. Three booleans are the only
// "rules": no expression language.

const OUTCOME_KEY = /^[a-z][a-z0-9_]{1,47}$/;
const STAGES = new Set<string>(["contacted", "lost"]);
const TASK_TYPES = new Set<string>(["CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "NO_SHOW_RECOVERY", "TREATMENT_DECISION", "POST_CARE", "RECALL", "OTHER"]);
const isStage = (v: unknown): v is OutcomeStage => typeof v === "string" && STAGES.has(v);
const isTaskType = (v: unknown): v is TaskType => typeof v === "string" && TASK_TYPES.has(v);

/** Recommended starting set, installed the first time a tenant has none. Tenants edit freely afterwards. */
export const DEFAULT_OUTCOMES: Omit<CrmOutcomeVm, "id" | "sortOrder" | "archived">[] = [
  { key: "interested", label: "Interested", stage: "contacted", requiresFollowUp: false, allowsAppointment: true, asksReason: false, followUpType: "FOLLOW_UP" },
  { key: "needs_callback", label: "Needs callback", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, followUpType: "CALLBACK" },
  { key: "price_enquiry", label: "Price enquiry", stage: "contacted", requiresFollowUp: false, allowsAppointment: false, asksReason: false, followUpType: "FOLLOW_UP" },
  { key: "needs_reports", label: "Needs reports", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, followUpType: "FOLLOW_UP" },
  { key: "discussing_with_family", label: "Discussing with family", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, followUpType: "FOLLOW_UP" },
  { key: "appointment_booked", label: "Appointment booked", stage: "contacted", requiresFollowUp: false, allowsAppointment: true, asksReason: false, followUpType: "FOLLOW_UP" },
  { key: "no_answer", label: "No answer", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, followUpType: "CALLBACK" },
  { key: "not_interested", label: "Not interested", stage: "lost", requiresFollowUp: false, allowsAppointment: false, asksReason: true, followUpType: "FOLLOW_UP" },
];

type Row = typeof crmOutcomes.$inferSelect;
const toVm = (r: Row): CrmOutcomeVm => ({
  id: r.id,
  key: r.key,
  label: r.label,
  stage: (isStage(r.stage) ? r.stage : "contacted") as OutcomeStage,
  requiresFollowUp: r.requiresFollowUp,
  allowsAppointment: r.allowsAppointment,
  asksReason: r.asksReason,
  followUpType: (isTaskType(r.followUpType) ? r.followUpType : "FOLLOW_UP") as TaskType,
  sortOrder: r.sortOrder,
  archived: r.archived,
});

/** Idempotent: installs the recommended set only when the tenant has no outcomes at all. */
export async function ensureDefaultOutcomes(db: Db, tenantId: string): Promise<void> {
  const [existing] = await db.select({ id: crmOutcomes.id }).from(crmOutcomes).where(eq(crmOutcomes.tenantId, tenantId)).limit(1);
  if (existing) return;
  await db.insert(crmOutcomes).values(DEFAULT_OUTCOMES.map((o, i) => ({ ...o, tenantId, sortOrder: i }))).onConflictDoNothing();
}

export async function listOutcomes(db: Db, tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<CrmOutcomeVm[]> {
  await ensureDefaultOutcomes(db, tenantId);
  const rows = await db
    .select()
    .from(crmOutcomes)
    .where(and(eq(crmOutcomes.tenantId, tenantId), opts.includeArchived ? undefined : eq(crmOutcomes.archived, false)))
    .orderBy(asc(crmOutcomes.sortOrder), asc(crmOutcomes.label));
  return rows.map(toVm);
}

export async function createOutcome(db: Db, tenantId: string, input: CreateCrmOutcomeInput): Promise<Result<{ outcome: CrmOutcomeVm }>> {
  if (!OUTCOME_KEY.test(input.key)) return { ok: false, reason: "invalid_key" };
  if (!isStage(input.stage) || (input.followUpType !== undefined && !isTaskType(input.followUpType)) || !input.label.trim()) return { ok: false, reason: "invalid_request" };
  await ensureDefaultOutcomes(db, tenantId);
  const siblings = await db.select({ key: crmOutcomes.key, sortOrder: crmOutcomes.sortOrder }).from(crmOutcomes).where(eq(crmOutcomes.tenantId, tenantId));
  if (siblings.some((s) => s.key === input.key)) return { ok: false, reason: "key_exists" };
  const [row] = await db
    .insert(crmOutcomes)
    .values({
      tenantId,
      key: input.key,
      label: input.label.trim(),
      stage: input.stage,
      requiresFollowUp: input.requiresFollowUp ?? false,
      allowsAppointment: input.allowsAppointment ?? false,
      asksReason: input.asksReason ?? false,
      followUpType: input.followUpType ?? "FOLLOW_UP",
      sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1) + 1,
    })
    .returning();
  return { ok: true, outcome: toVm(row) };
}

export async function updateOutcome(db: Db, tenantId: string, id: string, input: UpdateCrmOutcomeInput): Promise<Result<{ outcome: CrmOutcomeVm }>> {
  const [existing] = await db.select({ id: crmOutcomes.id, stage: crmOutcomes.stage }).from(crmOutcomes).where(and(eq(crmOutcomes.tenantId, tenantId), eq(crmOutcomes.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "outcome_not_found" };
  if ((input.stage !== undefined && !isStage(input.stage)) || (input.followUpType !== undefined && !isTaskType(input.followUpType)) || (input.label !== undefined && !input.label.trim())) return { ok: false, reason: "invalid_request" };
  // An outcome that has been recorded on journeys keeps its stage: moving "Interested" from Contacted to Lost would
  // re-read every past journey's history (and the next time it is logged, close journeys as lost). Archive it and add
  // a new outcome instead.
  if (input.stage !== undefined && input.stage !== existing.stage) {
    const [used] = await db.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.lastOutcomeId, id))).limit(1);
    if (used) return { ok: false, reason: "outcome_in_use" };
  }
  const [row] = await db
    .update(crmOutcomes)
    .set({
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.requiresFollowUp !== undefined ? { requiresFollowUp: input.requiresFollowUp } : {}),
      ...(input.allowsAppointment !== undefined ? { allowsAppointment: input.allowsAppointment } : {}),
      ...(input.asksReason !== undefined ? { asksReason: input.asksReason } : {}),
      ...(input.followUpType !== undefined ? { followUpType: input.followUpType } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
    })
    .where(eq(crmOutcomes.id, id))
    .returning();
  return { ok: true, outcome: toVm(row!) };
}

export async function reorderOutcomes(db: Db, tenantId: string, orderedIds: string[]): Promise<Result> {
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  const rows = await db.select().from(crmOutcomes).where(and(eq(crmOutcomes.tenantId, tenantId), inArray(crmOutcomes.id, orderedIds)));
  if (rows.length !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  // One stage at a time: a mixed list would swap sort slots across stages.
  if (new Set(rows.map((r) => r.stage)).size > 1) return { ok: false, reason: "invalid_request" };
  let slots = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
  if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0]! + i);
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) await tx.update(crmOutcomes).set({ sortOrder: slots[i]! }).where(and(eq(crmOutcomes.tenantId, tenantId), eq(crmOutcomes.id, id)));
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Logging an outcome on a Journey
// ---------------------------------------------------------------------------

/** An active (non-archived) outcome of this tenant by key, installing the default set first if the tenant has none. */
export async function findActiveOutcome(db: Db, tenantId: string, key: string): Promise<CrmOutcomeVm | null> {
  await ensureDefaultOutcomes(db, tenantId);
  const [row] = await db.select().from(crmOutcomes).where(and(eq(crmOutcomes.tenantId, tenantId), eq(crmOutcomes.key, key), eq(crmOutcomes.archived, false))).limit(1);
  return row ? toVm(row) : null;
}

export type LogResult =
  | { ok: true; result: LogInteractionResult }
  | { ok: false; reason: string; fields?: string[] };

/** Where a Journey may go. Only enquiry → contacted and enquiry/contacted → lost; nothing ever moves backwards. */
export function nextStage(current: JourneyStage, target: OutcomeStage): JourneyStage {
  if (target === "contacted") return current === "enquiry" ? "contacted" : current;
  return current === "enquiry" || current === "contacted" ? "lost" : current;
}

export async function logInteraction(
  db: Db,
  tenantId: string,
  actor: { id: string; role: Role },
  journeyId: string,
  input: LogInteractionInput,
  now: Date = new Date(),
  timezone = "Asia/Kolkata",
  /** `skipFollowUpTask`: the caller creates the follow-up itself (Add Lead uses the follow-up engine); `followUpAt` still satisfies "requires a follow-up". */
  opts: { skipFollowUpTask?: boolean } = {},
): Promise<LogResult> {
  await ensureDefaultOutcomes(db, tenantId);
  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).limit(1);
  if (!journey) return { ok: false, reason: "journey_not_found" };

  const [outcomeRow] = await db.select().from(crmOutcomes).where(and(eq(crmOutcomes.tenantId, tenantId), eq(crmOutcomes.key, input.outcomeKey), eq(crmOutcomes.archived, false))).limit(1);
  if (!outcomeRow) return { ok: false, reason: "outcome_not_found" };
  const outcome = toVm(outcomeRow);

  let followUpAt: Date | null = null;
  if (input.followUpAt !== undefined) {
    followUpAt = new Date(input.followUpAt);
    if (Number.isNaN(followUpAt.getTime())) return { ok: false, reason: "invalid_request" };
    if (followUpAt.getTime() <= now.getTime()) return { ok: false, reason: "follow_up_in_past" };
  }
  // A booked visit is the next step: it satisfies "requires a follow-up", and it is never combined with a follow-up task.
  const wantsAppointment = !!input.appointment;
  if (wantsAppointment) {
    if (followUpAt || typeof input.appointment!.scheduledAt !== "string" || !input.appointment!.scheduledAt.trim()) return { ok: false, reason: "follow_up_and_appointment" };
    if (!outcome.allowsAppointment) return { ok: false, reason: "outcome_disallows_appointment" };
  }
  if (outcome.requiresFollowUp && !followUpAt && !wantsAppointment) return { ok: false, reason: "follow_up_required" };
  let booking: { doctorId: string; branchId: string; scheduledAt: string; reason: string; confirmed: boolean } | null = null;
  if (wantsAppointment) {
    const targets = await resolveBookingTargets(db, tenantId, input.appointment!);
    if (!targets.ok) return targets;
    booking = { doctorId: targets.doctorId, branchId: targets.branchId, scheduledAt: input.appointment!.scheduledAt.trim(), reason: input.appointment!.reason?.trim() || "Consultation", confirmed: input.appointment!.confirmed === true };
  }

  let taskToComplete: typeof tasks.$inferSelect | null = null;
  if (input.taskId) {
    const [task] = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, input.taskId), eq(tasks.journeyId, journeyId))).limit(1);
    if (!task) return { ok: false, reason: "task_not_found" };
    if (task.status === "completed" || task.status === "cancelled") return { ok: false, reason: "task_closed" };
    taskToComplete = task;
  }

  // Fields configured for "follow-up outcome": validated by type, required ones enforced.
  const specialtyKey = journey.specialtyKey ?? "";
  const fieldDefs = specialtyKey ? await listFieldsForEntry(db, tenantId, actor.role, { placement: "followup_outcome", specialtyKey }) : [];
  const submitted = resolveSubmittedValues(fieldDefs, input.fieldValues, { outcomeKey: outcome.key, existing: await loadJourneyValuesByKey(db, tenantId, journeyId) });
  if (!submitted.ok) {
    if (submitted.missing.length > 0) return { ok: false, reason: "missing_required_fields", fields: submitted.missing };
    if (submitted.readOnly?.length) return { ok: false, reason: "field_read_only", fields: submitted.readOnly };
    return { ok: false, reason: "invalid_field_values", fields: submitted.invalid };
  }

  const stage = nextStage(journey.stage, outcome.stage);
  const stageChanged = stage !== journey.stage;
  const note = input.note?.trim() || null;
  const reason = outcome.asksReason ? input.reason?.trim() || null : null;
  const description = [note, reason ? `Reason: ${reason}` : null].filter(Boolean).join(" · ") || null;

  const publishAfterCommit: (() => void)[] = [];
  let bookingFailure: string | null = null;
  const result = await db.transaction(async (tx) => {
    let completedTaskId: string | null = null;
    if (taskToComplete) {
      // Guarded on the status we read, so two people logging against the same task cannot both complete it.
      const done = await tx
        .update(tasks)
        .set({ status: "completed", completedBy: actor.id, completedAt: now })
        .where(and(eq(tasks.id, taskToComplete.id), inArray(tasks.status, ["pending", "in_progress"])))
        .returning({ id: tasks.id });
      if (done.length === 0) return null;
      completedTaskId = taskToComplete.id;
      await tx.insert(timelineEvents).values({
        tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId: actor.id, eventType: "task_completed", occurredAt: now,
        title: `Task completed: ${taskToComplete.type.replace(/_/g, " ").toLowerCase()}`,
      });
    }

    await tx
      .update(journeys)
      .set({
        stage,
        lastOutcomeId: outcome.id,
        lastOutcomeAt: now,
        ...(journey.contactedAt === null && stage !== "enquiry" ? { contactedAt: now } : {}),
      })
      .where(eq(journeys.id, journeyId));

    await tx.insert(timelineEvents).values({
      tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId: actor.id, eventType: "outcome_logged", occurredAt: now,
      channel: input.channel ?? null,
      title: `Outcome: ${outcome.label}`,
      description,
      // What was recorded THIS time: the Journey keeps only the latest value of a field, the Timeline keeps each one as it was.
      ...(submitted.values.length > 0 ? { metadata: { fields: submitted.values.map(({ field, value }) => ({ key: field.key, label: field.label, value })) } } : {}),
    });

    let followUpTaskId: string | null = null;
    if (followUpAt && !opts.skipFollowUpTask) {
      const [task] = await tx
        .insert(tasks)
        .values({
          tenantId, patientId: journey.patientId, journeyId, assignedTo: journey.ownerUserId ?? actor.id,
          reason: "overdue_callback", type: outcome.followUpType, priority: "normal", status: "pending", dueAt: followUpAt, createdBy: actor.id,
          notes: [outcome.label, description].filter(Boolean).join(" — "),
        })
        .returning();
      followUpTaskId = task!.id;
      await tx.insert(timelineEvents).values({
        tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId: actor.id, eventType: "task_created", occurredAt: now,
        relatedEntityType: "task", relatedEntityId: task!.id, ...(await scheduledEvent(tx, tenantId, task!, timezone)),
      });
    }

    for (const { field, value } of submitted.values) {
      await tx
        .insert(customFieldValues)
        .values({ tenantId, journeyId, fieldDefinitionId: field.id, value })
        .onConflictDoUpdate({ target: [customFieldValues.journeyId, customFieldValues.fieldDefinitionId], set: { value } });
    }

    // The visit is booked in THIS transaction: if it is refused (outside hours, in the past, the doctor is taken) nothing is kept,
    // and the form still holds what staff typed.
    let appointmentId: string | null = null;
    if (booking) {
      const booked = await createAppointment(tx as unknown as Db, tenantId, actor.id, { patientId: journey.patientId, journeyId, branchId: booking.branchId, doctorId: booking.doctorId, scheduledAt: booking.scheduledAt, reason: booking.reason }, timezone, now, (publish) => publishAfterCommit.push(publish));
      if (!booked.ok) {
        bookingFailure = booked.reason;
        tx.rollback();
      } else {
        appointmentId = booked.appointment.id;
      }
    }

    return { completedTaskId, followUpTaskId, appointmentId };
  }).catch((err: unknown) => {
    if (bookingFailure) return undefined;
    throw err;
  });
  if (result === undefined) return { ok: false, reason: bookingFailure ?? "invalid_request" };
  if (!result) return { ok: false, reason: "task_closed" };
  for (const publish of publishAfterCommit) publish();

  // Only now (committed) is the visit confirmed: the confirmation and the 1-hour reminder are planned from that event.
  let appointmentStatus: "scheduled" | "confirmed" | null = result.appointmentId ? "scheduled" : null;
  if (result.appointmentId && booking?.confirmed) {
    const confirmed = await applyAppointmentAction(db, tenantId, result.appointmentId, actor.id, { action: "confirm" }, timezone, now);
    if (confirmed.ok) appointmentStatus = "confirmed";
  }

  emitIntegrationEvent({ type: "interaction.logged", tenantId, eventId: `interaction.logged:${journeyId}:${now.getTime()}:${outcome.key}`, occurredAt: now, data: { journeyId, outcomeKey: outcome.key, stageChanged, stage } });
  return { ok: true, result: { journeyId, stage, stageChanged, outcome, followUpTaskId: result.followUpTaskId, completedTaskId: result.completedTaskId, appointmentId: result.appointmentId, appointmentStatus } };
}

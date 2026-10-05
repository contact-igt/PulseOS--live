import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../db/client.js";
import { callIntelligence, calls, communicationEndpoints, connectors, crmOutcomes, journeys, patients, tasks, timelineEvents, users } from "../../db/schema.js";
import { hasPermission, type CallDirection, type CallFeedbackInput, type CallIntelligenceVm, type CallStatsVm, type CallStatus, type CallVm, type LogCallInput, type LogCallResult, type Role, type SummaryMode } from "@pulseos/types";
import { findActiveOutcome, nextStage } from "../crm/crm-outcome.service.js";
import { scheduledEvent } from "../task/task.service.js";
import { applyAppointmentAction, createAppointment, resolveBookingTargets } from "../appointment/appointment.service.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

const MAX_FEEDBACK = 2000;
const MAX_CALLBACK_NOTE = 500;
const FUTURE_SLACK_MS = 5 * 60_000;

/** A manual call has no provider status: connected → completed; not connected → missed (incoming) / no answer (outgoing). */
export function statusForManualCall(direction: CallDirection, connected: boolean): CallStatus {
  return connected ? "completed" : direction === "inbound" ? "missed" : "no_answer";
}
export const isConnectedStatus = (status: CallStatus): boolean => status === "completed";

export function formatCallDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/**
 * Calls as the browser sees them. The provider recording URL never leaves the server (`hasRecording` only); the
 * transcript text is a separate permission-checked endpoint; the AI summary is labelled by how it was made. Staff
 * feedback is a different column from anything derived, and is returned as its own field.
 */
export async function loadCallVms(db: Db | Tx, tenantId: string, where: ReturnType<typeof and>, viewerRole: Role): Promise<CallVm[]> {
  const feedbackUser = alias(users, "feedback_user");
  const loggedBy = alias(users, "logged_by_user");
  const rows = await db
    .select({
      call: calls,
      provider: connectors.provider,
      connectorMode: connectors.mode,
      endpointLabel: communicationEndpoints.displayLabel,
      loggedByName: loggedBy.name,
      feedbackByName: feedbackUser.name,
      outcomeLabel: crmOutcomes.label,
      callbackDueAt: tasks.dueAt,
      callbackStatus: tasks.status,
      intel: callIntelligence,
    })
    .from(calls)
    .leftJoin(connectors, eq(calls.connectorId, connectors.id))
    .leftJoin(communicationEndpoints, eq(calls.communicationEndpointId, communicationEndpoints.id))
    .leftJoin(loggedBy, eq(calls.loggedByUserId, loggedBy.id))
    .leftJoin(feedbackUser, eq(calls.feedbackByUserId, feedbackUser.id))
    .leftJoin(crmOutcomes, eq(calls.outcomeId, crmOutcomes.id))
    .leftJoin(tasks, eq(calls.callbackTaskId, tasks.id))
    .leftJoin(callIntelligence, eq(callIntelligence.callId, calls.id))
    .where(and(eq(calls.tenantId, tenantId), where))
    .orderBy(desc(calls.startedAt), desc(calls.createdAt));

  const mayReadTranscript = hasPermission(viewerRole, "VIEW_CALL_TRANSCRIPT");
  return rows.map((r) => {
    const c = r.call;
    const intel = r.intel;
    const intelligence: CallIntelligenceVm | null = intel
      ? {
          transcriptStatus: intel.transcriptStatus,
          hasTranscript: mayReadTranscript && intel.transcriptStatus === "COMPLETED" && !!intel.transcript,
          transcriptMode: intel.transcriptMode === "PROVIDER" ? "PROVIDER" : intel.transcriptMode === "FIXTURE" ? "FIXTURE" : null,
          summaryStatus: intel.summaryStatus,
          summary:
            intel.summaryStatus === "COMPLETED" && intel.summary && intel.generatedAt
              ? (() => {
                  const d = (intel.summaryDetails ?? {}) as Record<string, unknown>;
                  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
                  return {
                    text: intel.summary,
                    patientIntent: str(d.patientIntent),
                    serviceInterest: str(d.serviceInterest),
                    questions: Array.isArray(d.questions) ? d.questions.filter((q): q is string => typeof q === "string") : [],
                    agreedAction: str(d.agreedAction),
                    nextAction: str(d.nextAction),
                    mode: (intel.summaryMode as SummaryMode) ?? "FIXTURE",
                    generatedAt: intel.generatedAt.toISOString(),
                  };
                })()
              : null,
          failed: intel.transcriptStatus === "FAILED" || intel.summaryStatus === "FAILED",
        }
      : null;
    return {
      id: c.id,
      journeyId: c.journeyId,
      origin: c.origin,
      provider: r.provider ?? "manual",
      connectorMode: r.connectorMode ?? null,
      direction: c.direction,
      phone: c.phone,
      status: c.status,
      connected: isConnectedStatus(c.status),
      durationSeconds: c.durationSeconds,
      hasRecording: !!c.recordingUrl,
      disposition: c.disposition,
      agentName: c.origin === "MANUAL" ? (r.loggedByName ?? c.agentName) : c.agentName,
      staffFeedback: c.staffFeedback,
      staffFeedbackBy: r.feedbackByName ?? null,
      outcomeLabel: r.outcomeLabel ?? null,
      callback: c.callbackTaskId && r.callbackDueAt && r.callbackStatus ? { taskId: c.callbackTaskId, dueAt: r.callbackDueAt.toISOString(), status: r.callbackStatus } : null,
      intelligence,
      startedAt: c.startedAt ? c.startedAt.toISOString() : null,
      endedAt: c.endedAt ? c.endedAt.toISOString() : null,
      endpointLabel: r.endpointLabel ?? null,
    };
  });
}

export const listCallsForPatient = (db: Db, tenantId: string, patientId: string, viewerRole: Role) => loadCallVms(db, tenantId, eq(calls.patientId, patientId), viewerRole);

/** Truthful counts for one Journey, derived from its Call records every time — never stored as counters. */
export async function getCallStats(db: Db | Tx, tenantId: string, journeyId: string): Promise<CallStatsVm> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      incoming: sql<number>`count(*) filter (where ${calls.direction} = 'inbound')`,
      outgoing: sql<number>`count(*) filter (where ${calls.direction} = 'outbound')`,
      connected: sql<number>`count(*) filter (where ${calls.status} = 'completed')`,
      lastCallAt: sql<Date | null>`max(${calls.startedAt})`,
    })
    .from(calls)
    .where(and(eq(calls.tenantId, tenantId), eq(calls.journeyId, journeyId)));
  const total = Number(row?.total ?? 0);
  const connected = Number(row?.connected ?? 0);
  return {
    total,
    incoming: Number(row?.incoming ?? 0),
    outgoing: Number(row?.outgoing ?? 0),
    connected,
    notConnected: total - connected,
    lastCallAt: row?.lastCallAt ? new Date(row.lastCallAt).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface Actor {
  id: string;
  name: string;
  role: Role;
}

function validateCallback(callback: { dueAt: string; note?: string } | undefined, now: Date): { dueAt: Date; note: string | null } | { error: string } | null {
  if (!callback) return null;
  const dueAt = new Date(callback.dueAt);
  if (Number.isNaN(dueAt.getTime())) return { error: "invalid_request" };
  if (dueAt.getTime() <= now.getTime()) return { error: "callback_in_past" };
  const note = callback.note?.trim() || null;
  if (note && note.length > MAX_CALLBACK_NOTE) return { error: "invalid_request" };
  return { dueAt, note };
}

async function assigneeOk(db: Db | Tx, tenantId: string, userId: string): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, userId))).limit(1);
  return !!u;
}

/** The callback is the ordinary Task engine — one CALLBACK (or the outcome's follow-up type) Task, no separate table. */
async function createCallbackTask(
  tx: Tx,
  ctx: { tenantId: string; patientId: string; journeyId: string; ownerUserId: string | null; actorId: string; type: "CALLBACK" | string; label: string; timezone: string },
  callback: { dueAt: Date; note: string | null; assignedTo?: string },
  now: Date,
): Promise<string> {
  const [task] = await tx
    .insert(tasks)
    .values({
      tenantId: ctx.tenantId,
      patientId: ctx.patientId,
      journeyId: ctx.journeyId,
      assignedTo: callback.assignedTo ?? ctx.ownerUserId ?? ctx.actorId,
      reason: "overdue_callback",
      type: ctx.type as "CALLBACK",
      priority: "normal",
      status: "pending",
      dueAt: callback.dueAt,
      createdBy: ctx.actorId,
      notes: callback.note ?? "Callback requested on a call",
    })
    .returning();
  await tx.insert(timelineEvents).values({
    tenantId: ctx.tenantId, patientId: ctx.patientId, journeyId: ctx.journeyId, actorType: "user", actorId: ctx.actorId, eventType: "task_created", occurredAt: now,
    relatedEntityType: "task", relatedEntityId: task!.id, ...(await scheduledEvent(tx, ctx.tenantId, task!, ctx.timezone)),
  });
  return task!.id;
}

/**
 * Staff log a phone call from a Journey. One transaction: the Call, its Timeline line, the Journey's outcome
 * (forward-only, like every outcome) and — when asked for — the callback Task. If any part fails nothing is kept,
 * so a requested callback can never silently vanish. Patient, phone, department, source and service all come from
 * the Journey; the call count is derived, not typed.
 */
export async function logManualCall(db: Db, tenantId: string, actor: Actor, journeyId: string, input: LogCallInput, now: Date = new Date(), timezone = "Asia/Kolkata"): Promise<Result<LogCallResult>> {
  if (input.direction !== "inbound" && input.direction !== "outbound") return { ok: false, reason: "invalid_request" };
  if (typeof input.connected !== "boolean") return { ok: false, reason: "invalid_request" };
  const feedback = input.staffFeedback?.trim() || null;
  if (feedback && feedback.length > MAX_FEEDBACK) return { ok: false, reason: "invalid_request" };
  const duration = input.connected ? (input.durationSeconds ?? null) : null;
  if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 86_400)) return { ok: false, reason: "invalid_request" };
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
  if (Number.isNaN(occurredAt.getTime())) return { ok: false, reason: "invalid_request" };
  if (occurredAt.getTime() > now.getTime() + FUTURE_SLACK_MS) return { ok: false, reason: "occurred_in_future" };
  const callback = validateCallback(input.callback, now);
  if (callback && "error" in callback) return { ok: false, reason: callback.error };
  const key = input.idempotencyKey?.trim() || null;
  if (key && key.length > 80) return { ok: false, reason: "invalid_request" };
  // Next action is ONE of: nothing, a callback, a booked visit. Never both: a booked visit is the follow-up.
  const wantsAppointment = !!input.appointment;
  if (wantsAppointment && (input.callback || typeof input.appointment!.scheduledAt !== "string" || !input.appointment!.scheduledAt.trim())) return { ok: false, reason: "invalid_request" };
  if (wantsAppointment && input.appointment!.reason && input.appointment!.reason.length > 500) return { ok: false, reason: "invalid_request" };

  if (key) {
    const [existing] = await db.select({ id: calls.id, callbackTaskId: calls.callbackTaskId }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.idempotencyKey, key))).limit(1);
    if (existing) return { ok: true, callId: existing.id, callbackTaskId: existing.callbackTaskId, appointmentId: null, appointmentStatus: null, duplicate: true };
  }

  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).limit(1);
  if (!journey) return { ok: false, reason: "journey_not_found" };

  // Doctor and branch: as given, or the hospital's only one. Never guessed when there is a choice.
  let booking: { doctorId: string; branchId: string; scheduledAt: string; reason: string; confirmed: boolean } | null = null;
  if (wantsAppointment) {
    const a = input.appointment!;
    const targets = await resolveBookingTargets(db, tenantId, a);
    if (!targets.ok) return targets;
    booking = { doctorId: targets.doctorId, branchId: targets.branchId, scheduledAt: a.scheduledAt.trim(), reason: a.reason?.trim() || "Consultation", confirmed: a.confirmed === true };
  }
  const [patient] = await db.select({ phone: patients.phone }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, journey.patientId))).limit(1);
  if (!patient) return { ok: false, reason: "journey_not_found" };

  const outcome = input.outcomeKey ? await findActiveOutcome(db, tenantId, input.outcomeKey) : null;
  if (input.outcomeKey && !outcome) return { ok: false, reason: "outcome_not_found" };
  if (outcome?.requiresFollowUp && !callback && !booking) return { ok: false, reason: "follow_up_required" };
  if (callback && input.callback?.assignedTo && !(await assigneeOk(db, tenantId, input.callback.assignedTo))) return { ok: false, reason: "invalid_request" };

  const stage = outcome ? nextStage(journey.stage, outcome.stage) : journey.stage;
  const status = statusForManualCall(input.direction, input.connected);
  const endedAt = duration ? new Date(occurredAt.getTime() + duration * 1000) : occurredAt;
  const directionLabel = input.direction === "inbound" ? "Incoming" : "Outgoing";

  const publishAfterCommit: (() => void)[] = [];
  let bookingFailure: string | null = null;
  const out = await db.transaction(async (tx) => {
    const [call] = await tx
      .insert(calls)
      .values({
        tenantId, origin: "MANUAL", patientId: journey.patientId, journeyId, phone: patient.phone, direction: input.direction, status,
        durationSeconds: duration, agentName: actor.name, loggedByUserId: actor.id, startedAt: occurredAt, endedAt,
        staffFeedback: feedback, feedbackByUserId: feedback ? actor.id : null, feedbackAt: feedback ? now : null, outcomeId: outcome?.id ?? null, idempotencyKey: key,
      })
      .onConflictDoNothing({ target: [calls.tenantId, calls.idempotencyKey], where: sql`${calls.idempotencyKey} is not null` })
      .returning({ id: calls.id });
    if (!call) {
      // Lost a race on the idempotency key: the other request's call is the answer.
      const [existing] = await tx.select({ id: calls.id, callbackTaskId: calls.callbackTaskId }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.idempotencyKey, key!))).limit(1);
      return { callId: existing!.id, callbackTaskId: existing!.callbackTaskId, appointmentId: null as string | null, duplicate: true };
    }

    await tx.insert(timelineEvents).values({
      tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId: actor.id, eventType: "call_logged", channel: "MANUAL_CALL",
      title: `${directionLabel} call · ${input.connected ? "Connected" : "Not connected"}${duration ? ` · ${formatCallDuration(duration)}` : ""}`,
      occurredAt, relatedEntityType: "call", relatedEntityId: call.id,
    });

    if (outcome) {
      await tx
        .update(journeys)
        .set({ stage, lastOutcomeId: outcome.id, lastOutcomeAt: now, ...(journey.contactedAt === null && stage !== "enquiry" ? { contactedAt: now } : {}) })
        .where(eq(journeys.id, journeyId));
    }

    // Staff actually spoke to the patient: a new enquiry is now contacted, with or without a configured outcome (an outcome that
    // moves the stage further has already done so above). A call nobody answered changes nothing.
    if (!outcome && input.connected && journey.stage === "enquiry") {
      await tx.update(journeys).set({ stage: "contacted", contactedAt: journey.contactedAt ?? now }).where(and(eq(journeys.id, journeyId), eq(journeys.stage, "enquiry")));
    }

    let callbackTaskId: string | null = null;
    if (callback && !("error" in callback)) {
      callbackTaskId = await createCallbackTask(tx, { tenantId, patientId: journey.patientId, journeyId, ownerUserId: journey.ownerUserId, actorId: actor.id, type: outcome?.followUpType ?? "CALLBACK", label: outcome?.label ?? "Callback", timezone }, { ...callback, assignedTo: input.callback?.assignedTo }, now);
      await tx.update(calls).set({ callbackTaskId }).where(eq(calls.id, call.id));
    }

    // The visit is booked in THIS transaction (its own timeline line included): if the booking is refused — outside clinic
    // hours, in the past, the doctor already has that slot — the call is not kept either, and the form still holds what staff typed.
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
    return { callId: call.id, callbackTaskId, appointmentId, duplicate: false };
  }).catch((err: unknown) => {
    if (bookingFailure) return null;
    throw err;
  });
  if (!out) return { ok: false, reason: bookingFailure ?? "invalid_request" };
  for (const publish of publishAfterCommit) publish();

  // Only now (committed) is the visit confirmed: the confirmation message and 1-hour reminder are planned from that event.
  let appointmentStatus: "scheduled" | "confirmed" | null = out.appointmentId ? "scheduled" : null;
  if (out.appointmentId && booking?.confirmed) {
    const confirmed = await applyAppointmentAction(db, tenantId, out.appointmentId, actor.id, { action: "confirm" }, timezone, now);
    if (confirmed.ok) appointmentStatus = "confirmed";
  }
  if (!out.duplicate && (status === "completed" || status === "missed")) {
    emitIntegrationEvent({ type: status === "completed" ? "call.completed" : "call.missed", tenantId, eventId: `call.${status}:${out.callId}`, occurredAt: occurredAt, data: { callId: out.callId, journeyId, direction: input.direction, origin: "MANUAL" } });
  }
  return { ok: true, ...out, appointmentStatus };
}

/**
 * Add the human side to a call that already exists — typically an IVR call. Writes ONLY the human columns
 * (feedback, outcome, callback); the transcript and AI summary live in their own table and are never touched here.
 */
export async function addCallFeedback(db: Db, tenantId: string, actor: Actor, callId: string, input: CallFeedbackInput, now: Date = new Date(), timezone = "Asia/Kolkata"): Promise<Result<{ callbackTaskId: string | null }>> {
  const [call] = await db.select().from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId))).limit(1);
  if (!call) return { ok: false, reason: "call_not_found" };
  if (!call.patientId || !call.journeyId) return { ok: false, reason: "call_not_linked" };
  const feedback = input.staffFeedback?.trim() || null;
  if (feedback && feedback.length > MAX_FEEDBACK) return { ok: false, reason: "invalid_request" };
  if (!feedback && !input.outcomeKey && !input.callback) return { ok: false, reason: "invalid_request" };
  const callback = validateCallback(input.callback, now);
  if (callback && "error" in callback) return { ok: false, reason: callback.error };
  if (callback && call.callbackTaskId) return { ok: false, reason: "callback_exists" };
  const outcome = input.outcomeKey ? await findActiveOutcome(db, tenantId, input.outcomeKey) : null;
  if (input.outcomeKey && !outcome) return { ok: false, reason: "outcome_not_found" };
  if (outcome?.requiresFollowUp && !callback && !call.callbackTaskId) return { ok: false, reason: "follow_up_required" };
  if (callback && input.callback?.assignedTo && !(await assigneeOk(db, tenantId, input.callback.assignedTo))) return { ok: false, reason: "invalid_request" };

  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, call.journeyId))).limit(1);
  if (!journey) return { ok: false, reason: "call_not_linked" };

  const taskId = await db.transaction(async (tx) => {
    await tx
      .update(calls)
      .set({
        ...(feedback ? { staffFeedback: feedback, feedbackByUserId: actor.id, feedbackAt: now } : {}),
        ...(outcome ? { outcomeId: outcome.id } : {}),
      })
      .where(eq(calls.id, callId));
    if (outcome) {
      const stage = nextStage(journey.stage, outcome.stage);
      await tx.update(journeys).set({ stage, lastOutcomeId: outcome.id, lastOutcomeAt: now, ...(journey.contactedAt === null && stage !== "enquiry" ? { contactedAt: now } : {}) }).where(eq(journeys.id, journey.id));
    }
    if (callback && !("error" in callback)) {
      const id = await createCallbackTask(tx, { tenantId, patientId: journey.patientId, journeyId: journey.id, ownerUserId: journey.ownerUserId, actorId: actor.id, type: outcome?.followUpType ?? "CALLBACK", label: outcome?.label ?? "Callback", timezone }, { ...callback, assignedTo: input.callback?.assignedTo }, now);
      await tx.update(calls).set({ callbackTaskId: id }).where(eq(calls.id, callId));
      return id;
    }
    return null;
  });
  return { ok: true, callbackTaskId: taskId };
}

export async function getCallRecordingRef(db: Db, tenantId: string, callId: string): Promise<string | null> {
  const [row] = await db.select({ url: calls.recordingUrl }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId))).limit(1);
  return row?.url ?? null;
}

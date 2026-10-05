import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "../../db/client.js";
import { appointments, followUpTypes, journeys, tasks, timelineEvents } from "../../db/schema.js";
import { FOLLOW_UP_KEYS } from "@pulseos/types";
import { ensureFollowUpTypes } from "../task/followup-type.service.js";
import { scheduledEvent } from "../task/task.service.js";

/** The operational signals that raise an Appointment Risk task. One OPEN task per (appointment, signal). */
export type AppointmentRiskSignal = "no_show" | "hospital_reschedule" | "hospital_cancel";

const RISK_DUE_MINUTES: Record<AppointmentRiskSignal, number> = { no_show: 120, hospital_reschedule: 60, hospital_cancel: 60 };

type Appointment = typeof appointments.$inferSelect;

/**
 * Raises the Appointment Risk task for a signal, inside the caller's transaction. The partial unique index on
 * (appointment, signal) for open tasks makes this idempotent under concurrency: a second raise while the first is still
 * open inserts nothing. Returns the task id when this call created it, null when one was already open.
 */
export async function raiseAppointmentRisk(
  tx: Tx,
  tenantId: string,
  appointment: Pick<Appointment, "id" | "patientId" | "journeyId" | "scheduledAt">,
  signal: AppointmentRiskSignal,
  actorId: string,
  note: string,
  timezone: string,
  now: Date,
): Promise<string | null> {
  await ensureFollowUpTypes(tx, tenantId);
  // By stable key: a hospital that archived the label still gets its risk tasks, under the label it last had.
  const [type] = await tx.select().from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.key, FOLLOW_UP_KEYS.appointmentRisk))).limit(1);
  if (!type) return null;
  const [journey] = await tx.select({ ownerUserId: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, appointment.journeyId)).limit(1);

  const [task] = await tx
    .insert(tasks)
    .values({
      tenantId,
      patientId: appointment.patientId,
      journeyId: appointment.journeyId,
      assignedTo: journey?.ownerUserId ?? actorId,
      type: type.canonicalTaskType,
      followUpTypeId: type.id,
      priority: type.defaultPriority,
      status: "pending",
      reason: signal === "no_show" ? "no_show" : "manual_task",
      notes: note,
      dueAt: new Date(now.getTime() + RISK_DUE_MINUTES[signal] * 60_000),
      createdBy: actorId,
      appointmentId: appointment.id,
      riskReason: signal,
    })
    .onConflictDoNothing()
    .returning();
  if (!task) return null;

  const line = await scheduledEvent(tx, tenantId, task, timezone);
  await tx.insert(timelineEvents).values({
    tenantId, patientId: appointment.patientId, journeyId: appointment.journeyId,
    actorType: "system", actorId: null, eventType: "task_created", relatedEntityType: "task", relatedEntityId: task.id, ...line,
  });
  return task.id;
}

/** A visit that was missed is being rebooked, so its no-show recovery task is done. Silent: the reschedule line says it. */
export async function resolveNoShowRisk(tx: Tx, tenantId: string, appointmentId: string, actorId: string, now: Date): Promise<void> {
  await tx
    .update(tasks)
    .set({ status: "completed", completedBy: actorId, completedAt: now })
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.appointmentId, appointmentId), eq(tasks.riskReason, "no_show"), inArray(tasks.status, ["pending", "in_progress"])));
}

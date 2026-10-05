import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { patientNameSql } from "../../lib/patient-name.js";
import type { Db, DbOrTx } from "../../db/client.js";
import { hospitalTodayBounds, inLocalRange } from "../../lib/hospital-time.js";
import { followUpTypes, journeys, patients, tasks, timelineEvents, users } from "../../db/schema.js";
import { FOLLOW_UP_KEYS, TASK_TYPE_LABEL, type CreateFollowUpInput, type CreateTaskInput, type TaskCounts, type TaskReason, type TaskRow, type TaskView } from "@pulseos/types";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
import { dayKeyIn } from "../../lib/hospital-time.js";
import { ensureFollowUpTypes } from "./followup-type.service.js";

function toRow(r: {
  id: string; patientId: string; patientName: string; journeyId: string | null; journeyType: string | null; source?: TaskRow["source"];
  assignedTo: string | null; assignedToName: string | null; type: TaskRow["type"]; priority: TaskRow["priority"];
  status: TaskRow["status"]; reason: TaskRow["reason"]; notes: string | null; dueAt: Date; completedAt: Date | null; createdAt: Date;
  followUpTypeId?: string | null; followUpTypeKey?: string | null; typeLabel?: string | null;
}): TaskRow {
  return {
    id: r.id, patientId: r.patientId, patientName: r.patientName, journeyId: r.journeyId, journeyType: r.journeyType, source: r.source ?? null,
    assignedTo: r.assignedTo, assignedToName: r.assignedToName, type: r.type,
    followUpTypeId: r.followUpTypeId ?? null, followUpTypeKey: r.followUpTypeKey ?? null, typeLabel: r.typeLabel ?? TASK_TYPE_LABEL[r.type],
    priority: r.priority, status: r.status,
    reason: r.reason, notes: r.notes, dueAt: r.dueAt.toISOString(), completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

// A task's product label: its follow-up type's label (even once archived); a task without one resolves to the tenant's
// Callback / General Follow-up type by its stable type, so every callback reads "Callback" however it was created.
const defaultFt = alias(followUpTypes, "default_ft");
const defaultKeyFor = sql`case when ${tasks.type} = 'CALLBACK' then ${FOLLOW_UP_KEYS.callback} when ${tasks.type} = 'FOLLOW_UP' then ${FOLLOW_UP_KEYS.general} end`;
const typeColumns = {
  followUpTypeId: tasks.followUpTypeId,
  followUpTypeKey: followUpTypes.key,
  typeLabel: sql<string | null>`coalesce(${followUpTypes.label}, ${defaultFt.label})`,
};


// ---------------------------------------------------------------------------
// Task Timeline wording: one meaningful line per scheduling / completion, never one per minor edit.
// ---------------------------------------------------------------------------

/** "Fri 2 Oct, 11:00 am" in the hospital's clock — absolute, so the line never goes stale ("tomorrow"). */
export function formatDueForTimeline(due: Date, timezone: string): string {
  return due.toLocaleString("en-IN", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/** The label a task is shown under: its follow-up type, else the tenant's default for its stable type. */
export async function labelForTask(db: Db | Tx, tenantId: string, task: { type: TaskRow["type"]; followUpTypeId: string | null }): Promise<string> {
  if (task.followUpTypeId) {
    const [t] = await db.select({ label: followUpTypes.label }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.id, task.followUpTypeId))).limit(1);
    if (t) return t.label;
  }
  const key = task.type === "CALLBACK" ? FOLLOW_UP_KEYS.callback : task.type === "FOLLOW_UP" ? FOLLOW_UP_KEYS.general : null;
  if (key) {
    const [t] = await db.select({ label: followUpTypes.label }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.key, key))).limit(1);
    if (t) return t.label;
  }
  return TASK_TYPE_LABEL[task.type];
}

/** The one Timeline line for a follow-up being scheduled, shared by every path that creates a Task. */
export async function scheduledEvent(db: Db | Tx, tenantId: string, task: { type: TaskRow["type"]; followUpTypeId: string | null; dueAt: Date; assignedTo: string | null }, timezone: string) {
  const label = await labelForTask(db, tenantId, task);
  const [assignee] = task.assignedTo ? await db.select({ name: users.name }).from(users).where(eq(users.id, task.assignedTo)).limit(1) : [];
  return {
    title: `Follow-up scheduled · ${label}`,
    description: `Due ${formatDueForTimeline(task.dueAt, timezone)} · ${assignee ? `Assigned to ${assignee.name}` : "Unassigned"}`,
  };
}

// ---------------------------------------------------------------------------
// Validation shared by every way of creating or changing a task
// ---------------------------------------------------------------------------

/** Who may own a task: any person in THIS hospital (a Doctor can hold their own tasks). Never a user id from another one. */
export async function eligibleAssignee(db: Db | Tx, tenantId: string, userId: string): Promise<{ id: string; name: string } | null> {
  const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, userId))).limit(1);
  return u ?? null;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };
const PAST_SLACK_MS = 60_000;
const MAX_NOTE = 500;
// ---------------------------------------------------------------------------
// Next Action: derived from the open tasks, never stored
// ---------------------------------------------------------------------------

export type NextActionBucket = "overdue" | "today" | "upcoming";

export interface NextActionCandidate {
  dueAt: Date;
  priority: "normal" | "high";
}

/**
 * Overdue first, then due today (hospital clock), then the earliest upcoming; within a bucket high priority wins,
 * then the earliest due. Pure — the caller decides which tasks the viewer may see.
 */
export function deriveNextAction<T extends NextActionCandidate>(open: T[], now: Date, timezone: string): { task: T; bucket: NextActionBucket } | null {
  const todayKey = dayKeyIn(now, timezone);
  const bucketOf = (t: T): NextActionBucket => (t.dueAt.getTime() < now.getTime() ? "overdue" : dayKeyIn(t.dueAt, timezone) === todayKey ? "today" : "upcoming");
  const rank = { overdue: 0, today: 1, upcoming: 2 } as const;
  const sorted = open
    .map((task) => ({ task, bucket: bucketOf(task) }))
    .sort((a, b) => rank[a.bucket] - rank[b.bucket] || (a.task.priority === b.task.priority ? 0 : a.task.priority === "high" ? -1 : 1) || a.task.dueAt.getTime() - b.task.dueAt.getTime());
  return sorted[0] ?? null;
}

export interface TaskFilters {
  /** Filter to one follow-up type by its stable key. */
  followUpTypeKey?: string;
  view?: TaskView;
  assignedTo?: string;
  patientId?: string;
  reason?: TaskReason;
  /** Completed view only: hospital days (inclusive) the task was completed on. */
  completedWindow?: { from: string; to: string };
}

export async function listTasks(db: Db, tenantId: string, filters: TaskFilters, timezone: string): Promise<TaskRow[]> {
  const { start, end } = hospitalTodayBounds(timezone);
  const tz = timezone;
  const now = new Date();

  const viewCondition =
    filters.view === "today"
      ? and(eq(tasks.status, "pending"), gte(tasks.dueAt, start), lt(tasks.dueAt, end))
      : filters.view === "overdue"
        ? and(eq(tasks.status, "pending"), lt(tasks.dueAt, now))
        : filters.view === "upcoming"
          ? and(or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")), gte(tasks.dueAt, end))
          : filters.view === "completed"
            ? and(eq(tasks.status, "completed"), filters.completedWindow ? inLocalRange(tasks.completedAt, tz, filters.completedWindow.from, filters.completedWindow.to) : undefined)
            : filters.view === "unassigned"
              ? and(isNull(tasks.assignedTo), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")))
              : filters.view === "appointment_risk"
                ? and(or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")), eq(followUpTypes.key, FOLLOW_UP_KEYS.appointmentRisk))
                : undefined;

  const rows = await db
    .select({
      id: tasks.id, patientId: tasks.patientId, patientName: patientNameSql,
      journeyId: tasks.journeyId, journeyType: journeys.journeyType, source: journeys.source,
      assignedTo: tasks.assignedTo, assignedToName: users.name,
      type: tasks.type, priority: tasks.priority, status: tasks.status, reason: tasks.reason, notes: tasks.notes,
      dueAt: tasks.dueAt, completedAt: tasks.completedAt, createdAt: tasks.createdAt,
      ...typeColumns,
    })
    .from(tasks)
    .innerJoin(patients, eq(tasks.patientId, patients.id))
    .leftJoin(journeys, eq(tasks.journeyId, journeys.id))
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .leftJoin(followUpTypes, eq(tasks.followUpTypeId, followUpTypes.id))
    .leftJoin(defaultFt, and(eq(defaultFt.tenantId, tasks.tenantId), eq(defaultFt.key, defaultKeyFor)))
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        viewCondition,
        filters.assignedTo ? eq(tasks.assignedTo, filters.assignedTo) : undefined,
        filters.patientId ? eq(tasks.patientId, filters.patientId) : undefined,
        filters.reason ? eq(tasks.reason, filters.reason) : undefined,
        filters.followUpTypeKey ? eq(followUpTypes.key, filters.followUpTypeKey) : undefined,
      ),
    )
    .orderBy(tasks.dueAt);

  return rows.map(toRow);
}

/**
 * One aggregate query for the "My Work" tab counts, mirroring listTasks's
 * exact view-condition logic (today/overdue/upcoming/completed) via
 * COUNT(*) FILTER instead of four separate round trips. Scoped to the
 * caller's own assignment — never an arbitrary assignedTo override.
 *
 * `unassigned` is a second, tenant-wide query (never scoped to `userId` —
 * unassigned tasks by definition have no owner) and is only computed when
 * `canManageTasks` is true, matching the same MANAGE_TASKS gate that
 * task.routes.ts applies to the `unassigned` view itself — a VIEW_TASKS-only
 * caller (e.g. Doctor) gets `unassigned: undefined`, never a tenant count.
 */
export async function getTaskCounts(db: Db, tenantId: string, userId: string, canManageTasks: boolean, timezone: string, completedWindow?: { from: string; to: string }): Promise<TaskCounts> {
  const { start, end } = hospitalTodayBounds(timezone);
  const now = new Date();

  const overdueCond = and(eq(tasks.status, "pending"), lt(tasks.dueAt, now));
  const todayCond = and(eq(tasks.status, "pending"), gte(tasks.dueAt, start), lt(tasks.dueAt, end));
  const upcomingCond = and(or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")), gte(tasks.dueAt, end));
  const completedCond = and(eq(tasks.status, "completed"), completedWindow ? inLocalRange(tasks.completedAt, timezone, completedWindow.from, completedWindow.to) : undefined);

  const [row] = await db
    .select({
      mine: sql<number>`count(*)`,
      overdue: sql<number>`count(*) filter (where ${overdueCond})`,
      today: sql<number>`count(*) filter (where ${todayCond})`,
      upcoming: sql<number>`count(*) filter (where ${upcomingCond})`,
      completed: sql<number>`count(*) filter (where ${completedCond})`,
      appointmentRisk: sql<number>`count(*) filter (where ${followUpTypes.key} = ${FOLLOW_UP_KEYS.appointmentRisk} and ${tasks.status} in ('pending', 'in_progress'))`,
    })
    .from(tasks)
    .leftJoin(followUpTypes, eq(tasks.followUpTypeId, followUpTypes.id))
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.assignedTo, userId)));

  let unassigned: number | undefined;
  if (canManageTasks) {
    const [urow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), isNull(tasks.assignedTo), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress"))));
    unassigned = Number(urow.count);
  }

  return {
    mine: Number(row.mine),
    overdue: Number(row.overdue),
    today: Number(row.today),
    upcoming: Number(row.upcoming),
    completed: Number(row.completed),
    appointmentRisk: Number(row.appointmentRisk),
    unassigned,
  };
}

/**
 * The generic Task creator (My Work "Add Task", Add Lead's first follow-up). Everything it is pointed at must belong
 * to THIS hospital: the patient, the journey (and that journey to that patient), the assignee and the follow-up type.
 * It accepts a past due time (a hospital may record work that is already overdue); Add Follow-up on a Journey does not.
 */
export async function createTask(db: Db, tenantId: string, createdBy: string, input: CreateTaskInput, timezone = "Asia/Kolkata"): Promise<Result<{ task: TaskRow }>> {
  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) return { ok: false, reason: "invalid_due_at" };
  const [patient] = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, input.patientId))).limit(1);
  if (!patient) return { ok: false, reason: "patient_not_found" };
  if (input.journeyId) {
    const [j] = await db.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, input.journeyId), eq(journeys.patientId, input.patientId))).limit(1);
    if (!j) return { ok: false, reason: "journey_not_found" };
  }
  if (input.assignedTo && !(await eligibleAssignee(db, tenantId, input.assignedTo))) return { ok: false, reason: "assignee_invalid" };
  let followUpTypeId: string | null = null;
  if (input.followUpTypeId) {
    await ensureFollowUpTypes(db, tenantId);
    const [t] = await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.id, input.followUpTypeId), eq(followUpTypes.isActive, true))).limit(1);
    if (!t) return { ok: false, reason: "type_invalid" };
    followUpTypeId = t.id;
  }
  const [row] = await db
    .insert(tasks)
    .values({
      tenantId,
      patientId: input.patientId,
      journeyId: input.journeyId ?? null,
      assignedTo: input.assignedTo ?? null,
      type: input.type,
      followUpTypeId,
      priority: input.priority ?? "normal",
      notes: input.notes ?? null,
      dueAt,
      createdBy,
    })
    .returning();

  const line = await scheduledEvent(db, tenantId, row!, timezone);
  await db.insert(timelineEvents).values({
    tenantId, patientId: input.patientId, journeyId: input.journeyId ?? null,
    actorType: "user", actorId: createdBy, eventType: "task_created", ...line,
  });

  return { ok: true, task: (await getTaskById(db, tenantId, row!.id))! };
}

/**
 * Add Follow-up on a Journey: the Task engine, labelled with the hospital's follow-up type. Validates the type
 * (active, this hospital, offered for this journey's department), the due time (must be in the future), the
 * required note, and the owner (default per the type; an explicit owner must be a valid person in this hospital).
 */
export async function createFollowUp(dbOrTx: DbOrTx, tenantId: string, actor: { id: string }, journeyId: string, input: CreateFollowUpInput, timezone: string, now: Date = new Date()): Promise<Result<{ task: TaskRow }>> {
  // On the pool or inside a caller's transaction (then `db.transaction` below is a savepoint): the same queries either way.
  const db = dbOrTx as Db;
  if (!input || typeof input.followUpTypeId !== "string" || typeof input.dueAt !== "string") return { ok: false, reason: "invalid_request" };
  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).limit(1);
  if (!journey) return { ok: false, reason: "journey_not_found" };

  await ensureFollowUpTypes(db, tenantId);
  const [type] = await db.select().from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.id, input.followUpTypeId))).limit(1);
  if (!type || !type.isActive || (type.departmentId && type.departmentId !== journey.departmentId)) return { ok: false, reason: "type_invalid" };

  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) return { ok: false, reason: "invalid_due_at" };
  if (dueAt.getTime() < now.getTime() - PAST_SLACK_MS) return { ok: false, reason: "due_in_past" };

  const note = input.note?.trim() || null;
  if (note && note.length > MAX_NOTE) return { ok: false, reason: "invalid_request" };
  if (type.requiresNote && !note) return { ok: false, reason: "note_required" };
  if (input.priority !== undefined && input.priority !== "normal" && input.priority !== "high") return { ok: false, reason: "invalid_request" };

  let assignedTo: string | null;
  if (input.assignedTo === undefined) {
    assignedTo = type.defaultOwner === "UNASSIGNED" ? null : type.defaultOwner === "ACTOR" ? actor.id : (journey.ownerUserId ?? actor.id);
  } else if (input.assignedTo === null) {
    assignedTo = null;
  } else {
    if (!(await eligibleAssignee(db, tenantId, input.assignedTo))) return { ok: false, reason: "assignee_invalid" };
    assignedTo = input.assignedTo;
  }

  const row = await db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({ tenantId, patientId: journey.patientId, journeyId, assignedTo, type: type.canonicalTaskType, followUpTypeId: type.id, priority: input.priority ?? type.defaultPriority, status: "pending", reason: "manual_task", notes: note, dueAt, createdBy: actor.id })
      .returning();
    const line = await scheduledEvent(tx, tenantId, task!, timezone);
    await tx.insert(timelineEvents).values({ tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId: actor.id, eventType: "task_created", relatedEntityType: "task", relatedEntityId: task!.id, ...line });
    return task!;
  });
  // Only when this call owns the transaction: inside a caller's transaction the follow-up may still be rolled back.
  if (!("rollback" in (dbOrTx as object))) {
    emitIntegrationEvent({ type: "followup.created", tenantId, eventId: `followup.created:${row.id}`, occurredAt: now, data: { taskId: row.id, journeyId, followUpTypeId: type.id, dueAt: dueAt.toISOString() } });
  }
  return { ok: true, task: (await getTaskById(db, tenantId, row.id))! };
}

export async function completeTask(db: Db, tenantId: string, taskId: string, completedBy: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))).limit(1);
  if (!existing) return { ok: false, reason: "task_not_found" };
  if (existing.status === "completed" || existing.status === "cancelled") return { ok: false, reason: "already_completed" };

  // Guarded on the status we read, so two people completing the same task cannot both write a completion line.
  const done = await db.update(tasks).set({ status: "completed", completedBy, completedAt: new Date() }).where(and(eq(tasks.id, taskId), inArray(tasks.status, ["pending", "in_progress"]))).returning({ id: tasks.id });
  if (done.length === 0) return { ok: false, reason: "already_completed" };
  const label = await labelForTask(db, tenantId, existing);
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId: completedBy, eventType: "task_completed",
    title: `Follow-up completed · ${label}`,
  });
  return { ok: true };
}

export async function rescheduleTask(db: Db, tenantId: string, taskId: string, actorId: string, newDueAt: string, timezone: string, note?: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))).limit(1);
  if (!existing) return { ok: false, reason: "task_not_found" };
  if (existing.status === "completed" || existing.status === "cancelled") return { ok: false, reason: "already_completed" };
  const dueAt = new Date(newDueAt);
  if (Number.isNaN(dueAt.getTime())) return { ok: false, reason: "invalid_due_at" };
  if (dueAt.getTime() < now.getTime() - PAST_SLACK_MS) return { ok: false, reason: "due_in_past" };
  const why = note?.trim() || null;
  if (why && why.length > MAX_NOTE) return { ok: false, reason: "invalid_request" };

  await db.update(tasks).set({ dueAt, ...(why ? { notes: existing.notes ? `${existing.notes} — ${why}` : why } : {}) }).where(eq(tasks.id, taskId));
  const label = await labelForTask(db, tenantId, existing);
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "task_rescheduled",
    title: `Follow-up rescheduled · ${label}`, description: `Now due ${formatDueForTimeline(dueAt, timezone)}${why ? ` · ${why}` : ""}`,
  });
  return { ok: true };
}

export async function getTaskById(db: DbOrTx, tenantId: string, taskId: string): Promise<TaskRow | null> {
  const [row] = await db
    .select({
      id: tasks.id, patientId: tasks.patientId, patientName: patientNameSql,
      journeyId: tasks.journeyId, journeyType: journeys.journeyType, source: journeys.source,
      assignedTo: tasks.assignedTo, assignedToName: users.name,
      type: tasks.type, priority: tasks.priority, status: tasks.status, reason: tasks.reason, notes: tasks.notes,
      dueAt: tasks.dueAt, completedAt: tasks.completedAt, createdAt: tasks.createdAt,
      ...typeColumns,
    })
    .from(tasks)
    .innerJoin(patients, eq(tasks.patientId, patients.id))
    .leftJoin(journeys, eq(tasks.journeyId, journeys.id))
    .leftJoin(users, eq(tasks.assignedTo, users.id))
    .leftJoin(followUpTypes, eq(tasks.followUpTypeId, followUpTypes.id))
    .leftJoin(defaultFt, and(eq(defaultFt.tenantId, tasks.tenantId), eq(defaultFt.key, defaultKeyFor)))
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
    .limit(1);

  return row ? toRow(row) : null;
}

export async function addTaskNote(db: Db, tenantId: string, taskId: string, notes: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))).limit(1);
  if (!existing) return { ok: false, reason: "task_not_found" };

  await db.update(tasks).set({ notes }).where(eq(tasks.id, taskId));
  return { ok: true };
}

/**
 * Moves a task to another person in THIS hospital. The Journey's owner is deliberately left alone: who owns the
 * enquiry and who does this one piece of work can differ, and the UI shows both.
 */
export async function reassignTask(db: Db, tenantId: string, taskId: string, actorId: string, newAssigneeId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId))).limit(1);
  if (!existing) return { ok: false, reason: "task_not_found" };
  const assignee = typeof newAssigneeId === "string" ? await eligibleAssignee(db, tenantId, newAssigneeId) : null;
  if (!assignee) return { ok: false, reason: "assignee_invalid" };
  if (existing.status === "completed" || existing.status === "cancelled") return { ok: false, reason: "already_completed" };
  if (existing.assignedTo === assignee.id) return { ok: true };

  await db.update(tasks).set({ assignedTo: assignee.id }).where(eq(tasks.id, taskId));
  const label = await labelForTask(db, tenantId, existing);
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "task_reassigned",
    title: `Follow-up reassigned · ${label}`, description: `Now with ${assignee.name}`,
  });
  return { ok: true };
}

/** A Journey's Next Action = the nearest-due open task on it, or null if none scheduled. */
/**
 * A Journey's Next Action, derived from its open tasks every time (overdue → today → earliest upcoming). Returns the
 * label and due time only — callers decide whether the viewer may see the task itself.
 */
export async function getNextActionForJourney(db: Db, tenantId: string, journeyId: string, timezone: string, now: Date = new Date()) {
  const open = await db
    .select({ dueAt: tasks.dueAt, priority: tasks.priority, type: tasks.type, followUpTypeId: tasks.followUpTypeId })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.journeyId, journeyId), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress"))));
  const next = deriveNextAction(open, now, timezone);
  if (!next) return null;
  return { dueAt: next.task.dueAt, label: await labelForTask(db, tenantId, next.task), bucket: next.bucket };
}

import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import { inLocalRange, tenantTimezone } from "../../lib/hospital-time.js";
import type { Db, DbOrTx } from "../../db/client.js";
import { appointments, branches, journeys, patients, revenueEvents, scheduleResources, tasks, timelineEvents, treatmentOpportunities, users } from "../../db/schema.js";
import { recordConversionFeedbackEvent } from "../acquisition/conversion-feedback.service.js";
import { findActiveResource } from "../resource/resource.service.js";
import { findActiveTreatmentDefinition } from "../specialty/treatment-catalog.service.js";
import { emitAppointmentEvent } from "../appointment/appointment-events.js";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { capabilityEnabled } from "@pulseos/types";
import type { ScheduleSurgeryInput, TreatmentFilters, TreatmentRow, TreatmentStatus } from "@pulseos/types";

// Postgres unique_violation SQLSTATE. Used to recognize a lost race against
// the revenue_events_treatment_opportunity_unique index as "already recorded"
// rather than a real error — defense-in-depth behind the conditional-update
// guard below, in case some future path ever bypasses it.
const POSTGRES_UNIQUE_VIOLATION = "23505";
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION;
}

export async function listTreatments(db: Db, tenantId: string, filters: TreatmentFilters): Promise<TreatmentRow[]> {
  // The date filter names its dimension: the scheduled (planned) day or the completed day, in the hospital's calendar.
  const timezone = filters.dateField && filters.from && filters.to ? await tenantTimezone(db, tenantId) : null;
  const dateClause =
    timezone && filters.from && filters.to
      ? inLocalRange(filters.dateField === "completed" ? treatmentOpportunities.completedAt : treatmentOpportunities.plannedDate, timezone, filters.from, filters.to)
      : undefined;
  const rows = await db
    .select({
      id: treatmentOpportunities.id,
      patientId: treatmentOpportunities.patientId,
      patientName: patientNameSql,
      journeyId: treatmentOpportunities.journeyId,
      service: journeys.journeyType,
      treatmentDefinitionId: treatmentOpportunities.treatmentDefinitionId,
      treatmentLabel: treatmentOpportunities.treatmentLabel,
      estimatedValue: treatmentOpportunities.estimatedValue,
      status: treatmentOpportunities.status,
      ownerName: users.name,
      plannedDate: treatmentOpportunities.plannedDate,
      completedAt: treatmentOpportunities.completedAt,
      resourceId: treatmentOpportunities.scheduledResourceId,
      resourceName: scheduleResources.name,
      branchId: treatmentOpportunities.scheduledBranchId,
      branchName: branches.name,
      scheduleNote: treatmentOpportunities.scheduleNote,
    })
    .from(treatmentOpportunities)
    .innerJoin(patients, eq(treatmentOpportunities.patientId, patients.id))
    .innerJoin(journeys, eq(treatmentOpportunities.journeyId, journeys.id))
    .leftJoin(users, eq(treatmentOpportunities.ownerUserId, users.id))
    .leftJoin(scheduleResources, eq(treatmentOpportunities.scheduledResourceId, scheduleResources.id))
    .leftJoin(branches, eq(treatmentOpportunities.scheduledBranchId, branches.id))
    .where(
      and(
        eq(treatmentOpportunities.tenantId, tenantId),
        filters.status ? eq(treatmentOpportunities.status, filters.status) : undefined,
        filters.ownerId ? eq(treatmentOpportunities.ownerUserId, filters.ownerId) : undefined,
        filters.treatmentDefinitionId ? eq(treatmentOpportunities.treatmentDefinitionId, filters.treatmentDefinitionId) : undefined,
        filters.service ? eq(journeys.journeyType, filters.service) : undefined,
        dateClause,
      ),
    )
    .orderBy(treatmentOpportunities.updatedAt);

  const journeyIds = rows.map((r) => r.journeyId);
  if (journeyIds.length === 0) return [];

  const doctorRows = await db
    .select({ journeyId: appointments.journeyId, doctorId: appointments.resourceId, doctorUserId: appointments.doctorUserId, doctorName: scheduleResources.name, scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .leftJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
    .where(eq(appointments.tenantId, tenantId));
  const latestApptByJourney = new Map<string, Date>();
  const doctorByJourney = new Map<string, string | null>();
  const doctorIdByJourney = new Map<string, { resourceId: string | null; userId: string | null }>();
  for (const d of doctorRows) {
    const existing = latestApptByJourney.get(d.journeyId);
    if (!existing || d.scheduledAt > existing) {
      latestApptByJourney.set(d.journeyId, d.scheduledAt);
      doctorByJourney.set(d.journeyId, d.doctorName);
      doctorIdByJourney.set(d.journeyId, { resourceId: d.doctorId, userId: d.doctorUserId });
    }
  }

  const taskRows = await db
    .select({ journeyId: tasks.journeyId, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress"))));
  const nextActionByJourney = new Map<string, Date>();
  for (const t of taskRows) {
    if (!t.journeyId) continue;
    const existing = nextActionByJourney.get(t.journeyId);
    if (!existing || t.dueAt < existing) nextActionByJourney.set(t.journeyId, t.dueAt);
  }

  const timelineRows = await db
    .select({ journeyId: timelineEvents.journeyId, occurredAt: timelineEvents.occurredAt })
    .from(timelineEvents)
    .where(eq(timelineEvents.tenantId, tenantId));
  const lastContactByJourney = new Map<string, Date>();
  for (const t of timelineRows) {
    if (!t.journeyId) continue;
    const existing = lastContactByJourney.get(t.journeyId);
    if (!existing || t.occurredAt > existing) lastContactByJourney.set(t.journeyId, t.occurredAt);
  }

  // "Doctor" is the one who last saw the journey (latest appointment) — the same rule the row's doctorName uses.
  // A scheduled procedure with its own doctor/resource is filed under that one. A login's user id still matches (old links).
  const visibleRows = filters.doctorId
    ? rows.filter((r) => {
        if (r.resourceId) return r.resourceId === filters.doctorId;
        const d = doctorIdByJourney.get(r.journeyId);
        return d?.resourceId === filters.doctorId || d?.userId === filters.doctorId;
      })
    : rows;

  return visibleRows.map((r) => ({
    id: r.id,
    patientId: r.patientId,
    patientName: r.patientName,
    journeyId: r.journeyId,
    doctorName: r.resourceName ?? doctorByJourney.get(r.journeyId) ?? null,
    service: r.service,
    treatmentDefinitionId: r.treatmentDefinitionId,
    treatmentLabel: r.treatmentLabel,
    estimatedValue: r.estimatedValue,
    status: r.status,
    ownerName: r.ownerName,
    nextActionDueAt: nextActionByJourney.get(r.journeyId)?.toISOString() ?? null,
    lastContactAt: lastContactByJourney.get(r.journeyId)?.toISOString() ?? null,
    plannedDate: r.plannedDate?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    branchId: r.branchId,
    branchName: r.branchName,
    scheduleNote: r.scheduleNote,
  }));
}

const VALID_TRANSITIONS: Record<TreatmentStatus, TreatmentStatus[]> = {
  ADVISED: ["DECISION_PENDING", "ACCEPTED", "DECLINED", "CANCELLED"],
  DECISION_PENDING: ["ACCEPTED", "DECLINED", "CANCELLED"],
  ACCEPTED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
  LOST: [],
};

export async function updateTreatmentStatus(
  db: Db,
  tenantId: string,
  treatmentId: string,
  actorId: string,
  nextStatus: TreatmentStatus,
  plannedDate?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [existing] = await db.select().from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.id, treatmentId))).limit(1);
  if (!existing) return { ok: false, reason: "treatment_not_found" };
  if (!VALID_TRANSITIONS[existing.status].includes(nextStatus)) return { ok: false, reason: "invalid_transition" };
  const plannedAt = plannedDate ? new Date(plannedDate) : null;
  if (plannedAt && Number.isNaN(plannedAt.getTime())) return { ok: false, reason: "invalid_request" };
  // A hospital with revenue tracking off records the completion but never a payment: no financial workflow is created.
  const recordRevenue = nextStatus === "COMPLETED" ? capabilityEnabled(await tenantCapabilityMap(db, tenantId), "REVENUE_TRACKING") : true;

  // The read above and the write below are two separate round-trips, so two
  // concurrent requests can both read the pre-transition status and both pass
  // the VALID_TRANSITIONS check before either commits (classic check-then-act
  // race). The UPDATE's WHERE clause re-guards on the exact status we just
  // validated against: under Postgres's normal row-locking behavior, the
  // second writer blocks on the first writer's row lock, then re-evaluates
  // WHERE against the now-committed (changed) row and affects zero rows — so
  // at most one caller ever proceeds past this point for a given transition.
  const transitioned = await db.transaction(async (tx) => {
    // One server-clock instant for the whole transition: the completion stamp, the payment event and updatedAt agree.
    const at = new Date();
    const [updated] = await tx
      .update(treatmentOpportunities)
      .set({
        status: nextStatus,
        updatedAt: at,
        // COMPLETED is final (no transition leaves it), so this is stamped exactly once; the conditional UPDATE below
        // lets only one of two racing completions through. Nothing else writes this column.
        ...(nextStatus === "COMPLETED" ? { completedAt: at } : {}),
        decisionDate: nextStatus === "ACCEPTED" || nextStatus === "DECLINED" ? new Date() : existing.decisionDate,
        // "Scheduled for" belongs to scheduling: this status endpoint may only set it on the way to SCHEDULED
        // (scheduleSurgery / rescheduleSurgery own it otherwise). A completion never rewrites when it was planned.
        plannedDate: nextStatus === "SCHEDULED" && plannedAt ? plannedAt : existing.plannedDate,
      })
      .where(and(
        eq(treatmentOpportunities.id, treatmentId),
        eq(treatmentOpportunities.tenantId, tenantId),
        eq(treatmentOpportunities.status, existing.status),
      ))
      .returning();

    if (!updated) return null;

    await tx.insert(timelineEvents).values({
      tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
      actorType: "user", actorId, eventType: "treatment_status_changed",
      title: existing.status === "SCHEDULED" && nextStatus === "CANCELLED"
        ? `Surgery cancelled · ${existing.treatmentLabel}`
        : `Treatment "${existing.treatmentLabel}" — ${nextStatus.replace(/_/g, " ").toLowerCase()}`,
      relatedEntityType: "treatment_opportunity", relatedEntityId: existing.id,
    });

    if (nextStatus === "ACCEPTED") {
      const [journey] = await tx.select().from(journeys).where(eq(journeys.id, existing.journeyId)).limit(1);
      await tx.update(journeys).set({ stage: "treatment_advised" }).where(eq(journeys.id, existing.journeyId));
      if (journey) {
        const dueAt = new Date();
        dueAt.setDate(dueAt.getDate() + 2);
        await tx.insert(tasks).values({
          tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
          assignedTo: existing.ownerUserId ?? journey.ownerUserId, reason: "treatment_decision_pending",
          type: "TREATMENT_DECISION", priority: "high", status: "pending", dueAt, createdBy: actorId,
          notes: "Schedule accepted treatment",
        });
      }
    }

    if (nextStatus === "COMPLETED") {
      const [journey] = await tx.select().from(journeys).where(eq(journeys.id, existing.journeyId)).limit(1);
      const assignedTo = existing.ownerUserId ?? journey?.ownerUserId ?? null;

      const postCareDueAt = new Date();
      postCareDueAt.setDate(postCareDueAt.getDate() + 1);
      const reviewDueAt = new Date();
      reviewDueAt.setDate(reviewDueAt.getDate() + 7);

      await tx.insert(tasks).values([
        {
          tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
          assignedTo, reason: "manual_task", type: "POST_CARE", priority: "normal",
          status: "pending", dueAt: postCareDueAt, createdBy: actorId,
          notes: `Post-care call — check on patient after "${existing.treatmentLabel}"`,
        },
        {
          tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
          assignedTo, reason: "manual_task", type: "RECALL", priority: "normal",
          status: "pending", dueAt: reviewDueAt, createdBy: actorId,
          notes: `Schedule review appointment for "${existing.treatmentLabel}"`,
        },
      ]);

      // Revenue attribution write path: a completed treatment is real,
      // attributable revenue. estimatedValue is the only amount available at
      // completion time today (no separate "actual paid amount" field yet).
      // treatmentOpportunities.journeyId is NOT NULL, so existing.journeyId is
      // always a real journey here — never defaulted or guessed. Idempotency
      // is primarily the conditional UPDATE above (only one concurrent caller
      // ever reaches this insert for a given treatment); the unique index on
      // revenue_events.treatment_opportunity_id is DB-backed defense-in-depth,
      // handled gracefully via a savepoint so a stray violation can't abort
      // the rest of this transaction.
      try {
        if (recordRevenue) await tx.transaction(async (tx2) => {
          await tx2.insert(revenueEvents).values({
            tenantId,
            patientId: existing.patientId,
            journeyId: existing.journeyId,
            treatmentOpportunityId: existing.id,
            amount: existing.estimatedValue,
            currency: "INR",
            type: "treatment_payment",
            occurredAt: at,
            sourceSystem: "treatment_completion",
          });
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Already recorded for this treatment — idempotent no-op.
      }
    }

    return updated;
  });

  if (!transitioned) return { ok: false, reason: "conflict" };
  if (existing.status === "SCHEDULED" && nextStatus === "CANCELLED") emitAppointmentEvent({ type: "surgery.cancelled", tenantId, treatmentId, plannedDate: existing.plannedDate });

  if (nextStatus === "COMPLETED") {
    emitIntegrationEvent({ type: "surgery.completed", tenantId, eventId: `surgery.completed:${treatmentId}`, occurredAt: new Date(), data: { treatmentId, journeyId: existing.journeyId } });
    // A completed treatment is the checkpoint-specified trigger point for
    // conversion feedback — this only ever builds a candidate record
    // (consent-gated, idempotent), never sends anything to a real provider.
    // Best-effort, matching its own doc comment: the status transition and
    // revenue event above are already durably committed by this point, so a
    // failure here must never surface as if the completion itself failed —
    // the caller would see a false 500 on an already-successful change with
    // no way to tell (a retry would just hit "already completed").
    try {
      await recordConversionFeedbackEvent(db, tenantId, existing.journeyId, "TREATMENT_COMPLETED", existing.estimatedValue, "INR");
    } catch (err) {
      console.error(`recordConversionFeedbackEvent failed for treatment ${treatmentId} after completion was already committed`, err);
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Scheduling a surgery (operational only: procedure, when, with whom, where — no clinical fields)
// ---------------------------------------------------------------------------

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };
const PAST_SLACK_MS = 60_000;
const MAX_NOTE = 500;
/** Statuses in which a procedure for this Journey is still open: re-used rather than duplicated. */
const OPEN_BEFORE_SCHEDULE: TreatmentStatus[] = ["ADVISED", "DECISION_PENDING", "ACCEPTED"];

/** The shortest legal path from one status to another through VALID_TRANSITIONS (BFS), excluding the start. */
function pathThrough(from: TreatmentStatus, to: TreatmentStatus): TreatmentStatus[] | null {
  const queue: TreatmentStatus[][] = [[from]];
  const seen = new Set<TreatmentStatus>([from]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1]!;
    if (last === to) return path.slice(1);
    for (const n of VALID_TRANSITIONS[last]) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push([...path, n]);
      }
    }
  }
  return null;
}

function validScheduleTime(raw: unknown, now: Date): Result<{ at: Date }> {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_request" };
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "invalid_request" };
  if (at.getTime() < now.getTime() - PAST_SLACK_MS) return { ok: false, reason: "scheduled_in_past" };
  return { ok: true, at };
}

function validNote(raw: unknown): Result<{ note: string | null }> {
  if (raw !== undefined && raw !== null && typeof raw !== "string") return { ok: false, reason: "invalid_request" };
  const n = typeof raw === "string" ? raw.trim() : "";
  return n.length > MAX_NOTE ? { ok: false, reason: "invalid_request" } : { ok: true, note: n || null };
}

/** "Mon 12 Oct, 9:30 am" on the hospital's clock. */
function when(at: Date, timezone: string): string {
  return at.toLocaleString("en-IN", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Schedules a catalog procedure for a Journey. Everything referenced must belong to THIS hospital (journey, procedure,
 * doctor/resource, branch). The Journey's open treatment for that procedure is reused — else one is created — and moved
 * to SCHEDULED hop by hop through the SAME transition graph the pipeline uses; nothing assigns the status directly.
 * Scheduling a procedure that is already SCHEDULED for the Journey is refused, and concurrent attempts serialize on
 * an advisory lock, so a double click can never produce two records. Runs on the pool or inside the caller's transaction.
 */
export async function scheduleSurgery(
  dbOrTx: DbOrTx,
  tenantId: string,
  actorId: string,
  journeyId: string,
  input: ScheduleSurgeryInput,
  timezone: string,
  now: Date = new Date(),
): Promise<Result<{ treatmentId: string; plannedDate: Date }>> {
  if (!input || typeof input.treatmentDefinitionId !== "string" || typeof input.resourceId !== "string" || typeof input.branchId !== "string") return { ok: false, reason: "invalid_request" };
  const time = validScheduleTime(input.scheduledAt, now);
  if (!time.ok) return time;
  const note = validNote(input.note);
  if (!note.ok) return note;

  const db = dbOrTx as Db;
  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).limit(1);
  if (!journey) return { ok: false, reason: "journey_not_found" };
  const definition = await findActiveTreatmentDefinition(db, tenantId, input.treatmentDefinitionId);
  if (!definition) return { ok: false, reason: "treatment_invalid" };
  const resource = await findActiveResource(db, tenantId, input.resourceId);
  if (!resource) return { ok: false, reason: "resource_invalid" };
  const [branch] = await db.select({ id: branches.id, name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId))).limit(1);
  if (!branch) return { ok: false, reason: "branch_invalid" };

  return db.transaction(async (tx): Promise<Result<{ treatmentId: string; plannedDate: Date }>> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`surgery:${journeyId}:${definition.id}`}))`);

    const current = await tx
      .select()
      .from(treatmentOpportunities)
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.journeyId, journeyId), eq(treatmentOpportunities.treatmentDefinitionId, definition.id), inArray(treatmentOpportunities.status, [...OPEN_BEFORE_SCHEDULE, "SCHEDULED"])))
      .orderBy(desc(treatmentOpportunities.createdAt));
    if (current.some((t) => t.status === "SCHEDULED")) return { ok: false, reason: "surgery_already_scheduled" };

    let opportunity = current[0];
    if (!opportunity) {
      [opportunity] = await tx
        .insert(treatmentOpportunities)
        .values({ tenantId, patientId: journey.patientId, journeyId, treatmentLabel: definition.label, treatmentDefinitionId: definition.id, status: "ADVISED", estimatedValue: definition.defaultEstimatedValue ?? 0, ownerUserId: journey.ownerUserId })
        .returning();
    }
    const hops = pathThrough(opportunity!.status, "SCHEDULED");
    if (!hops) return { ok: false, reason: "invalid_transition" };

    let status = opportunity!.status;
    for (const next of hops) {
      const [moved] = await tx
        .update(treatmentOpportunities)
        .set({ status: next, updatedAt: now, ...(next === "ACCEPTED" ? { decisionDate: now } : {}) })
        .where(and(eq(treatmentOpportunities.id, opportunity!.id), eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.status, status)))
        .returning({ id: treatmentOpportunities.id });
      if (!moved) return { ok: false, reason: "conflict" };
      status = next;
    }
    await tx
      .update(treatmentOpportunities)
      .set({ plannedDate: time.at, scheduledResourceId: resource.id, scheduledBranchId: branch.id, scheduleNote: note.note, updatedAt: now })
      .where(eq(treatmentOpportunities.id, opportunity!.id));

    await tx.insert(timelineEvents).values({
      tenantId, patientId: journey.patientId, journeyId, actorType: "user", actorId, eventType: "surgery_scheduled",
      title: `Surgery scheduled · ${definition.label}`,
      description: `${when(time.at, timezone)} · ${resource.name} · ${branch.name}${note.note ? ` · ${note.note}` : ""}`,
      relatedEntityType: "treatment_opportunity", relatedEntityId: opportunity!.id,
    });
    // The Journey has reached its procedure date; never moves a Journey backwards from completed / lost.
    await tx.update(journeys).set({ stage: "scheduled" }).where(and(eq(journeys.id, journeyId), inArray(journeys.stage, ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised"])));
    return { ok: true, treatmentId: opportunity!.id, plannedDate: time.at };
  });
}

/** Moves a SCHEDULED procedure to another time / doctor / branch. Nothing else about the treatment changes. */
export async function rescheduleSurgery(
  db: Db,
  tenantId: string,
  actorId: string,
  treatmentId: string,
  input: Partial<ScheduleSurgeryInput> & { scheduledAt: string },
  timezone: string,
  now: Date = new Date(),
): Promise<Result<{ alreadyApplied?: boolean }>> {
  const time = validScheduleTime(input?.scheduledAt, now);
  if (!time.ok) return time;
  const note = validNote(input.note);
  if (!note.ok) return note;
  const [existing] = await db.select().from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.id, treatmentId))).limit(1);
  if (!existing) return { ok: false, reason: "treatment_not_found" };
  if (existing.status !== "SCHEDULED") return { ok: false, reason: "invalid_transition" };

  let resourceId = existing.scheduledResourceId;
  if (input.resourceId !== undefined) {
    const r = await findActiveResource(db, tenantId, input.resourceId);
    if (!r) return { ok: false, reason: "resource_invalid" };
    resourceId = r.id;
  }
  let branchId = existing.scheduledBranchId;
  if (input.branchId !== undefined) {
    const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId))).limit(1);
    if (!b) return { ok: false, reason: "branch_invalid" };
    branchId = b.id;
  }
  const nextNote = input.note === undefined ? existing.scheduleNote : note.note;
  if (existing.plannedDate?.getTime() === time.at.getTime() && resourceId === existing.scheduledResourceId && branchId === existing.scheduledBranchId && nextNote === existing.scheduleNote) return { ok: true, alreadyApplied: true };

  const moved = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(treatmentOpportunities)
      .set({ plannedDate: time.at, scheduledResourceId: resourceId, scheduledBranchId: branchId, scheduleNote: nextNote, updatedAt: now })
      .where(and(eq(treatmentOpportunities.id, treatmentId), eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.status, "SCHEDULED")))
      .returning({ id: treatmentOpportunities.id });
    if (!updated) return false;
    const [resource] = resourceId ? await tx.select({ name: scheduleResources.name }).from(scheduleResources).where(eq(scheduleResources.id, resourceId)).limit(1) : [];
    const [branch] = branchId ? await tx.select({ name: branches.name }).from(branches).where(eq(branches.id, branchId)).limit(1) : [];
    await tx.insert(timelineEvents).values({
      tenantId, patientId: existing.patientId, journeyId: existing.journeyId, actorType: "user", actorId, eventType: "surgery_rescheduled",
      title: `Surgery rescheduled · ${existing.treatmentLabel}`,
      description: [when(time.at, timezone), resource?.name, branch?.name].filter(Boolean).join(" · "),
      relatedEntityType: "treatment_opportunity", relatedEntityId: existing.id,
    });
    return true;
  });
  if (!moved) return { ok: false, reason: "conflict" };
  emitAppointmentEvent({ type: "surgery.rescheduled", tenantId, treatmentId, plannedDate: time.at });
  return { ok: true };
}

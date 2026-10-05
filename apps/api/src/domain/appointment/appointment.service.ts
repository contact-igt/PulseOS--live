import { and, asc, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import type { Db, DbOrTx, Tx } from "../../db/client.js";
import { inLocalRange, localToday, minutesOfDayIn, parseInstant, tenantTimezone } from "../../lib/hospital-time.js";
import { appointments, branches, journeys, patients, scheduleResources, tenants, timelineEvents } from "../../db/schema.js";
import {
  APPOINTMENT_REASONS,
  APPOINTMENT_TRANSITIONS,
  type AppointmentAction,
  type AppointmentActionInput,
  type AppointmentActionResult,
  type AppointmentReasonCode,
  type AppointmentReasonKind,
  type AppointmentRow,
  type AppointmentOp,
  type AppointmentStatus,
  type CompleteAppointmentInput,
  type CompleteAppointmentResult,
  type CreateAppointmentInput,
  type FrontDeskDashboard,
  type RescheduleAppointmentInput,
} from "@pulseos/types";
import { findActiveResource } from "../resource/resource.service.js";
import { createFollowUp, formatDueForTimeline } from "../task/task.service.js";
import { scheduleSurgery } from "../treatment/treatment.service.js";
import { raiseAppointmentRisk, resolveNoShowRisk, type AppointmentRiskSignal } from "./appointment-risk.service.js";
import { emitAppointmentEvent } from "./appointment-events.js";

/** Longest from/to span a list request may ask for: a month grid (42 days) plus slack. */
export const MAX_APPOINTMENT_RANGE_DAYS = 62;
const MAX_NOTE = 500;
const PAST_SLACK_MS = 60_000;

type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Is `at` inside the hospital's clinic hours (tenants.clinicHours), judged on the hospital's LOCAL weekday and clock?
 * Open is inclusive, close exclusive; a null day is closed; no hours set (null) means no restriction.
 */
async function withinClinicHours(db: DbOrTx, tenantId: string, at: Date, timezone: string): Promise<boolean> {
  const [row] = await db.select({ clinicHours: tenants.clinicHours }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!row?.clinicHours) return true;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(at).slice(0, 3).toLowerCase() as Weekday;
  const day = row.clinicHours[weekday];
  if (!day) return false;
  const minutes = minutesOfDayIn(at, timezone);
  return minutes >= toMinutes(day[0]) && minutes < toMinutes(day[1]);
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

/**
 * The doctor and branch for a visit booked from another screen (a call, a logged follow-up): as given, or the hospital's ONLY
 * active doctor / its only branch. Never guessed when there is a choice - the caller is told which one is missing.
 */
export async function resolveBookingTargets(db: DbOrTx, tenantId: string, given: { doctorId?: string; branchId?: string }): Promise<Result<{ doctorId: string; branchId: string }>> {
  const only = async (rows: PromiseLike<{ id: string }[]>) => {
    const found = await rows;
    return found.length === 1 ? found[0]!.id : null;
  };
  const doctorId = given.doctorId ?? (await only(db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, tenantId), eq(scheduleResources.isActive, true))).limit(2)));
  if (!doctorId) return { ok: false, reason: "doctor_required" };
  const branchId = given.branchId ?? (await only(db.select({ id: branches.id }).from(branches).where(eq(branches.tenantId, tenantId)).limit(2)));
  if (!branchId) return { ok: false, reason: "branch_required" };
  return { ok: true, doctorId, branchId };
}


// ---------------------------------------------------------------------------
// Slot collisions. An appointment has a start time but no duration, so a "collision" is the same doctor/resource at
// the same start MINUTE (seconds never make a free slot). Cancelled and no-show visits free the slot; everything else
// — including a visit already completed — held it. Bookings and reschedules take a per-resource transaction lock
// first, so two requests racing for one slot are serialised and exactly one wins; the loser is told, never double-booked.
// (A unique index is not used: historical data may legitimately hold same-minute rows, and a migration must not fail.)
// ---------------------------------------------------------------------------

const SLOT_FREE_STATUSES: AppointmentStatus[] = ["cancelled", "no_show"];

async function lockResourceSlots(tx: Tx, tenantId: string, resourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`appt-slot:${tenantId}:${resourceId}`}))`);
}

async function resourceSlotTaken(tx: DbOrTx, tenantId: string, resourceId: string, at: Date, excludeAppointmentId?: string): Promise<boolean> {
  const [hit] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.resourceId, resourceId),
        notInArray(appointments.status, SLOT_FREE_STATUSES),
        sql`date_trunc('minute', ${appointments.scheduledAt}) = date_trunc('minute', ${at.toISOString()}::timestamptz)`,
        excludeAppointmentId ? ne(appointments.id, excludeAppointmentId) : undefined,
      ),
    )
    .limit(1);
  return !!hit;
}

/**
 * Advisory pre-check for the booking form: is this doctor free at this time? Says nothing about WHO holds a taken slot.
 * The authoritative check is still the booking itself (create/reschedule), under the resource lock.
 */
export async function checkSlot(db: Db, tenantId: string, doctorId: string, scheduledAt: unknown, timezone: string, excludeAppointmentId?: string, now: Date = new Date()): Promise<Result<{ available: boolean; inPast: boolean; outsideHours: boolean }>> {
  const at = parseInstant(scheduledAt, timezone);
  if (!at) return { ok: false, reason: "invalid_request" };
  const resource = await findActiveResource(db, tenantId, doctorId);
  if (!resource) return { ok: false, reason: "doctor_not_found" };
  const inPast = at.getTime() < now.getTime() - PAST_SLACK_MS;
  // The same clinic-hours rule booking enforces, so the form never calls a time "available" that booking would refuse.
  const outsideHours = !inPast && !(await withinClinicHours(db, tenantId, at, timezone));
  return { ok: true, inPast, outsideHours, available: !inPast && !outsideHours && !(await resourceSlotTaken(db, tenantId, resource.id, at, excludeAppointmentId)) };
}

/** The hospital's IANA zone and its current local day - what "today" means for every appointment view. */
export async function getCalendarContext(db: Db, tenantId: string, now: Date = new Date()): Promise<{ timezone: string; today: string }> {
  const timezone = await tenantTimezone(db, tenantId);
  return { timezone, today: await localToday(db, timezone, now) };
}

export interface AppointmentFilters {
  branchId?: string;
  /** A schedule resource id (the doctor/profile the visit is with). A login's user id is still accepted for old links. */
  doctorId?: string;
  journeyId?: string;
  status?: AppointmentStatus;
  /** One local day (YYYY-MM-DD) in the tenant's timezone. */
  date?: string;
  /** Inclusive local-day range (YYYY-MM-DD) in the tenant's timezone; used by the calendar views. */
  from?: string;
  to?: string;
  search?: string;
}

const REASON_LABEL = new Map(APPOINTMENT_REASONS.map((r) => [r.code, r.label]));
const REASON_BY_CODE = new Map(APPOINTMENT_REASONS.map((r) => [r.code, r]));

const rowColumns = {
  id: appointments.id,
  patientId: appointments.patientId,
  patientName: patientNameSql,
  journeyId: appointments.journeyId,
  branchName: branches.name,
  doctorId: appointments.resourceId,
  doctorName: scheduleResources.name,
  status: appointments.status,
  scheduledAt: appointments.scheduledAt,
  reason: appointments.reason,
  checkedInAt: appointments.checkedInAt,
  waitingStartedAt: appointments.waitingStartedAt,
  consultationStartedAt: appointments.consultationStartedAt,
  completedAt: appointments.completedAt,
  statusReasonCode: appointments.statusReasonCode,
  statusReasonNote: appointments.statusReasonNote,
  atRisk: sql<boolean>`exists (select 1 from tasks rt where rt.appointment_id = ${appointments.id} and rt.status in ('pending', 'in_progress'))`,
  service: journeys.journeyType,
  serviceKey: journeys.specialtyKey,
  branchId: appointments.branchId,
  bookedBy: sql<string | null>`(select u.name from timeline_events te join users u on u.id = te.actor_id where te.related_entity_id = ${appointments.id} and te.event_type = 'appointment_created' order by te.occurred_at limit 1)`,
};

type SelectedRow = {
  id: string; patientId: string; patientName: string; journeyId: string; branchName: string | null;
  doctorId: string | null; doctorName: string | null; status: AppointmentStatus; scheduledAt: Date; reason: string | null;
  checkedInAt: Date | null; waitingStartedAt: Date | null; consultationStartedAt: Date | null; completedAt: Date | null;
  statusReasonCode: string | null; statusReasonNote: string | null; atRisk: boolean; service: string | null; serviceKey: string | null; branchId: string; bookedBy: string | null;
};

function toRow(r: SelectedRow): AppointmentRow {
  const code = r.statusReasonCode as AppointmentReasonCode | null;
  return {
    id: r.id, patientId: r.patientId, patientName: r.patientName, journeyId: r.journeyId, branchName: r.branchName,
    doctorId: r.doctorId ?? "", doctorName: r.doctorName, status: r.status, scheduledAt: r.scheduledAt.toISOString(), reason: r.reason,
    arrivedAt: r.checkedInAt?.toISOString() ?? null,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    waitingStartedAt: r.waitingStartedAt?.toISOString() ?? null,
    consultationStartedAt: r.consultationStartedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    statusReason: code ? { code, label: REASON_LABEL.get(code) ?? code, note: r.statusReasonNote } : null,
    atRisk: !!r.atRisk,
    service: r.service,
    serviceKey: r.serviceKey,
    branchId: r.branchId,
    bookedBy: r.bookedBy,
  };
}

async function selectAppointments(db: Db | Tx, tenantId: string, filters: AppointmentFilters) {
  // Day boundaries are the hospital's local midnight (tenants.timezone), never
  // UTC and never the API server's own clock zone.
  const days = filters.from && filters.to ? { from: filters.from, to: filters.to } : filters.date ? { from: filters.date, to: filters.date } : undefined;
  const dayClause = days ? inLocalRange(appointments.scheduledAt, await tenantTimezone(db as Db, tenantId), days.from, days.to) : undefined;

  const rows = await db
    .select(rowColumns)
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(journeys, eq(appointments.journeyId, journeys.id))
    .innerJoin(branches, eq(appointments.branchId, branches.id))
    .innerJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        filters.branchId ? eq(appointments.branchId, filters.branchId) : undefined,
        filters.doctorId ? or(eq(appointments.resourceId, filters.doctorId), eq(appointments.doctorUserId, filters.doctorId)) : undefined,
        filters.journeyId ? eq(appointments.journeyId, filters.journeyId) : undefined,
        filters.status ? eq(appointments.status, filters.status) : undefined,
        dayClause,
      ),
    )
    .orderBy(asc(appointments.scheduledAt));

  const search = filters.search?.trim().toLowerCase();
  return search ? rows.filter((r) => r.patientName.toLowerCase().includes(search)) : rows;
}

export async function listAppointments(db: Db, tenantId: string, filters: AppointmentFilters): Promise<AppointmentRow[]> {
  const rows = await selectAppointments(db, tenantId, filters);
  return rows.map(toRow);
}

export async function getAppointmentRow(db: Db | Tx, tenantId: string, id: string): Promise<AppointmentRow | null> {
  const [row] = await db
    .select(rowColumns)
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(journeys, eq(appointments.journeyId, journeys.id))
    .innerJoin(branches, eq(appointments.branchId, branches.id))
    .innerJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, id)))
    .limit(1);
  return row ? toRow(row) : null;
}

/** "10:16 am" on the hospital's clock. */
function clock(at: Date, timezone: string): string {
  return at.toLocaleTimeString("en-IN", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true });
}

/**
 * Books a visit. Everything it points at must belong to THIS hospital: the patient, the journey (and that journey to
 * that patient), the branch, and an active doctor/resource. A bad reference is refused — it never lands as a
 * cross-hospital row.
 */
export async function createAppointment(
  db: Db,
  tenantId: string,
  actorId: string,
  input: CreateAppointmentInput,
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
  /** Inside a caller's transaction: receives the "booked" event to publish once THAT transaction has committed. */
  afterCommit?: (publish: () => void) => void,
): Promise<{ ok: true; appointment: AppointmentRow } | { ok: false; reason: string }> {
  // An offset-less time is the hospital's wall time; the past is judged on the instant, so the browser's and the
  // server's zones never matter. Refused here, not just in the picker: a direct API call cannot book the past.
  const scheduledAt = parseInstant(input.scheduledAt, timezone);
  if (!scheduledAt) return { ok: false, reason: "invalid_request" };
  if (scheduledAt.getTime() < now.getTime() - PAST_SLACK_MS) return { ok: false, reason: "appointment_time_in_past" };
  if (!(await withinClinicHours(db, tenantId, scheduledAt, timezone))) return { ok: false, reason: "outside_clinic_hours" };
  const [journey] = await db.select({ id: journeys.id }).from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, input.journeyId), eq(journeys.patientId, input.patientId))).limit(1);
  if (!journey) return { ok: false, reason: "journey_not_found" };
  const [branch] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, input.branchId))).limit(1);
  if (!branch) return { ok: false, reason: "branch_not_found" };
  const resource = await findActiveResource(db, tenantId, input.doctorId);
  if (!resource) return { ok: false, reason: "doctor_not_found" };

  const row = await db.transaction(async (tx) => {
    await lockResourceSlots(tx, tenantId, resource.id);
    if (await resourceSlotTaken(tx, tenantId, resource.id, scheduledAt)) return null;
    const [created] = await tx
      .insert(appointments)
      .values({ tenantId, patientId: input.patientId, journeyId: input.journeyId, branchId: input.branchId, resourceId: resource.id, scheduledAt, reason: input.reason ?? null, status: "scheduled" })
      .returning();
    await tx.insert(timelineEvents).values({
      tenantId,
      patientId: input.patientId,
      journeyId: input.journeyId,
      actorType: "user",
      actorId,
      eventType: "appointment_created",
      // Hospital clock, not the server's, and absolute so it never goes stale.
      title: `Appointment booked · ${formatDueForTimeline(scheduledAt, timezone)}`,
      relatedEntityType: "appointment",
      relatedEntityId: created!.id,
    });
    return created!;
  });
  if (!row) return { ok: false, reason: "resource_unavailable" };
  const publish = () => emitAppointmentEvent({ type: "appointment.booked", tenantId, appointmentId: row.id, scheduledAt });
  if (afterCommit) afterCommit(publish);
  else publish();
  return { ok: true, appointment: (await getAppointmentRow(db, tenantId, row.id))! };
}

/** The queue for a hospital day: today by default, or any other day (`date`, YYYY-MM-DD) when staff look back or ahead. */
export async function getFrontDeskDashboard(db: Db, tenantId: string, branchId?: string, now: Date = new Date(), date?: string): Promise<FrontDeskDashboard> {
  const { today: todayKey } = await getCalendarContext(db, tenantId, now);
  const day = date ?? todayKey;
  const todayRows = (await selectAppointments(db, tenantId, { branchId, from: day, to: day })).map(toRow);

  const arrivals = todayRows.filter((r) => r.status === "checked_in" || r.status === "waiting" || r.status === "with_doctor" || r.status === "completed");
  // Longest-waiting first: arrival time (real timestamp), falling back to the booked time.
  const waitingQueue = todayRows
    .filter((r) => r.status === "checked_in" || r.status === "waiting")
    .sort((a, b) => (a.checkedInAt ?? a.scheduledAt).localeCompare(b.checkedInAt ?? b.scheduledAt));
  const noShows = todayRows.filter((r) => r.status === "no_show");
  const pendingConfirmations = todayRows.filter((r) => r.status === "requested" || r.status === "scheduled");
  const atRisk = todayRows.filter((r) => r.atRisk);

  return { date: day, today: todayRows, arrivals, waitingQueue, noShows, pendingConfirmations, atRisk };
}

// ---------------------------------------------------------------------------
// Transitions. The graph itself is shared with the UI (@pulseos/types APPOINTMENT_TRANSITIONS); what lives here is
// what a step WRITES.
// ---------------------------------------------------------------------------

const ACTION_STATUS: Record<AppointmentAction, AppointmentStatus> = {
  confirm: "confirmed",
  check_in: "checked_in",
  mark_waiting: "waiting",
  send_to_doctor: "with_doctor",
  mark_no_show: "no_show",
  cancel: "cancelled",
};

const ACTION_EVENT: Record<AppointmentAction, string> = {
  confirm: "appointment_confirmed",
  check_in: "appointment_checked_in",
  mark_waiting: "appointment_waiting",
  send_to_doctor: "appointment_with_doctor",
  mark_no_show: "appointment_no_show",
  cancel: "appointment_cancelled",
};

/** One meaningful Timeline line per step, in the hospital's clock. */
function actionLine(action: AppointmentAction | "queue", at: Date, timezone: string, reasonLabel: string | null, note: string | null): { title: string; description: string | null } {
  const t = clock(at, timezone);
  const why = reasonLabel ? `Reason: ${reasonLabel}${note ? ` · ${note}` : ""}` : null;
  switch (action) {
    case "confirm": return { title: "Appointment confirmed", description: null };
    case "check_in": return { title: `Checked in · ${t}`, description: null };
    case "queue": return { title: `Patient checked in · Waiting · ${t}`, description: null };
    case "mark_waiting": return { title: `Waiting · ${t}`, description: null };
    case "send_to_doctor": return { title: `Consultation started · ${t}`, description: null };
    case "mark_no_show": return { title: "No-show", description: why };
    case "cancel": return { title: "Appointment cancelled", description: why };
  }
}

function validReason(kind: AppointmentReasonKind, code: unknown, note: unknown): Result<{ code: AppointmentReasonCode; note: string | null; hospitalAction: boolean }> {
  if (typeof code !== "string") return { ok: false, reason: "reason_required" };
  const def = REASON_BY_CODE.get(code as AppointmentReasonCode);
  if (!def || !def.appliesTo.includes(kind)) return { ok: false, reason: "reason_invalid" };
  if (note !== undefined && note !== null && typeof note !== "string") return { ok: false, reason: "invalid_request" };
  const n = typeof note === "string" ? note.trim() : "";
  if (n.length > MAX_NOTE) return { ok: false, reason: "invalid_request" };
  return { ok: true, code: def.code, note: n || null, hospitalAction: def.hospitalAction };
}

/**
 * Check in / waiting / with doctor / confirm / no-show / cancel. Enforces APPOINTMENT_TRANSITIONS server-side, writes
 * the event timestamp, the one Timeline line and (for no-show / hospital-caused cancellation) the Appointment Risk
 * task in a single transaction. The status write is guarded on the status that was read, so two people pressing the
 * same button produce one transition: the loser sees the appointment already in the requested state and nothing is
 * written twice.
 */
export async function applyAppointmentAction(
  db: Db,
  tenantId: string,
  appointmentId: string,
  actorId: string,
  input: AppointmentActionInput,
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
): Promise<Result<Omit<AppointmentActionResult, "ok">>> {
  const action = input?.action;
  if (!action || !(action in ACTION_STATUS)) return { ok: false, reason: "invalid_request" };
  const [existing] = await db.select().from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  if (!existing) return { ok: false, reason: "appointment_not_found" };
  // "Check in" from the desk means arrived AND waiting: one validated step, one transaction (never two requests that could half-apply).
  // A legacy visit already checked in but not yet queued just joins the queue.
  const queue = action === "check_in" && input.queue === true;
  const target: AppointmentStatus = queue ? "waiting" : ACTION_STATUS[action];
  if (existing.status === target) return { ok: true, status: target, alreadyApplied: true };
  if (existing.status === "completed" || (existing.status === "cancelled" && action !== "cancel")) return { ok: false, reason: "appointment_closed" };
  const allowedOp: AppointmentOp = queue && existing.status === "checked_in" ? "mark_waiting" : action;
  if (!APPOINTMENT_TRANSITIONS[existing.status].includes(allowedOp)) return { ok: false, reason: "invalid_transition" };

  let reason: { code: AppointmentReasonCode; note: string | null; hospitalAction: boolean } | null = null;
  if (action === "cancel") {
    const r = validReason("cancel", input.reasonCode, input.note);
    if (!r.ok) return r;
    reason = r;
  } else if (action === "mark_no_show") {
    const r = validReason("no_show", input.reasonCode ?? "patient_no_show", input.note);
    if (!r.ok) return r;
    reason = r;
  }

  const stamp: Partial<typeof appointments.$inferInsert> = {};
  if (action === "check_in" && existing.status !== "checked_in") stamp.checkedInAt = now;
  if (action === "mark_waiting" || queue) stamp.waitingStartedAt = now;
  if (action === "send_to_doctor") stamp.consultationStartedAt = now;
  if (action === "mark_no_show") stamp.noShowAt = now;
  if (action === "cancel") stamp.cancelledAt = now;
  if (reason) {
    stamp.statusReasonCode = reason.code;
    stamp.statusReasonNote = reason.note;
  }

  const moved = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(appointments)
      .set({ status: target, ...stamp })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId), eq(appointments.status, existing.status)))
      .returning({ id: appointments.id });
    if (!updated) return false;

    const line = actionLine(queue ? "queue" : action, now, timezone, reason ? (REASON_LABEL.get(reason.code) ?? reason.code) : null, reason?.note ?? null);
    await tx.insert(timelineEvents).values({
      tenantId, patientId: existing.patientId, journeyId: existing.journeyId, actorType: "user", actorId,
      eventType: queue && existing.status === "checked_in" ? ACTION_EVENT.mark_waiting : ACTION_EVENT[action], relatedEntityType: "appointment", relatedEntityId: appointmentId, ...line,
    });

    // The risk: a missed visit always needs recovering; a cancellation only when the hospital caused it.
    const signal: AppointmentRiskSignal | null = action === "mark_no_show" ? "no_show" : action === "cancel" && reason?.hospitalAction ? "hospital_cancel" : null;
    if (signal) {
      const detail = signal === "no_show"
        ? `Did not arrive for the ${clock(existing.scheduledAt, timezone)} appointment. Reason: ${REASON_LABEL.get(reason!.code)}${reason!.note ? ` · ${reason!.note}` : ""}`
        : `Appointment for ${formatDueForTimeline(existing.scheduledAt, timezone)} was cancelled by the hospital (${REASON_LABEL.get(reason!.code)}). Contact the patient.`;
      await raiseAppointmentRisk(tx, tenantId, existing, signal, actorId, detail, timezone, now);
    }
    return true;
  });

  if (!moved) {
    // Lost the race. If the winner put it where we wanted, this is a repeat click; otherwise it genuinely moved on.
    const [now2] = await db.select({ status: appointments.status }).from(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId))).limit(1);
    if (now2?.status === target) return { ok: true, status: target, alreadyApplied: true };
    return { ok: false, reason: "invalid_transition" };
  }

  if (action === "confirm") emitAppointmentEvent({ type: "appointment.confirmed", tenantId, appointmentId });
  if (action === "cancel") emitAppointmentEvent({ type: "appointment.cancelled", tenantId, appointmentId, reasonCode: reason!.code, hospitalAction: reason!.hospitalAction });
  if (action === "mark_no_show") emitAppointmentEvent({ type: "appointment.no_show", tenantId, appointmentId });
  return { ok: true, status: target };
}

class Abort extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Finishes the consultation and, in the SAME transaction, does what the Staff chose next: nothing, a follow-up Task
 * (the M5 follow-up engine) or a scheduled surgery (the treatment lifecycle). If the follow-up or surgery is refused
 * the appointment is not completed — the caller never sees a "completed" visit whose requested next step vanished.
 * Completing twice completes once and creates nothing a second time.
 */
export async function completeAppointment(
  db: Db,
  tenantId: string,
  appointmentId: string,
  actor: { id: string; canManageTreatment: boolean },
  input: CompleteAppointmentInput = {},
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
): Promise<Result<Omit<CompleteAppointmentResult, "ok">>> {
  const [existing] = await db.select().from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  if (!existing) return { ok: false, reason: "appointment_not_found" };
  if (existing.status === "completed") return { ok: true, alreadyApplied: true };
  if (existing.status !== "with_doctor") return { ok: false, reason: "not_with_doctor" };

  const next = input?.next ?? { kind: "none" as const };
  if (next.kind !== "none" && next.kind !== "follow_up" && next.kind !== "surgery") return { ok: false, reason: "invalid_request" };
  if (next.kind === "surgery" && !actor.canManageTreatment) return { ok: false, reason: "forbidden" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_NOTE) return { ok: false, reason: "invalid_request" };

  let followUpTaskId: string | null = null;
  let treatmentId: string | null = null;
  let plannedDate: Date | null = null;
  try {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(appointments)
        .set({ status: "completed", completedAt: now })
        .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId), eq(appointments.status, "with_doctor")))
        .returning({ id: appointments.id });
      if (!updated) throw new Abort("conflict");

      await tx.insert(timelineEvents).values({
        tenantId, patientId: existing.patientId, journeyId: existing.journeyId, actorType: "user", actorId: actor.id,
        eventType: "appointment_completed", relatedEntityType: "appointment", relatedEntityId: appointmentId,
        title: `Consultation completed · ${clock(now, timezone)}`, description: note || null,
      });

      if (next.kind === "follow_up") {
        const r = await createFollowUp(tx, tenantId, { id: actor.id }, existing.journeyId, next.followUp, timezone, now);
        if (!r.ok) throw new Abort(r.reason);
        followUpTaskId = r.task.id;
      } else if (next.kind === "surgery") {
        const r = await scheduleSurgery(tx, tenantId, actor.id, existing.journeyId, next.surgery, timezone, now);
        if (!r.ok) throw new Abort(r.reason);
        treatmentId = r.treatmentId;
        plannedDate = r.plannedDate;
      }
    });
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
    if (err.reason === "conflict") {
      const [again] = await db.select({ status: appointments.status }).from(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId))).limit(1);
      return again?.status === "completed" ? { ok: true, alreadyApplied: true } : { ok: false, reason: "not_with_doctor" };
    }
    return { ok: false, reason: err.reason };
  }

  emitAppointmentEvent({ type: "appointment.completed", tenantId, appointmentId });
  if (treatmentId) emitAppointmentEvent({ type: "surgery.scheduled", tenantId, treatmentId, plannedDate });
  return { ok: true, followUpTaskId, treatmentId };
}

/**
 * Moves a visit that has not happened yet (booked / confirmed / requested, or a missed or cancelled one being rebooked).
 * The new time must be in the future on the hospital's clock; the reason is a stable code. A hospital-caused change
 * raises an Appointment Risk task (the patient has to be told); rebooking a no-show resolves its recovery task.
 */
export async function rescheduleAppointment(
  db: Db,
  tenantId: string,
  appointmentId: string,
  actorId: string,
  input: RescheduleAppointmentInput,
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
): Promise<Result<{ alreadyApplied?: boolean }>> {
  const newAt = parseInstant(input?.scheduledAt, timezone);
  if (!newAt) return { ok: false, reason: "invalid_request" };
  const [existing] = await db.select().from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  if (!existing) return { ok: false, reason: "appointment_not_found" };
  if (existing.status === "completed") return { ok: false, reason: "appointment_closed" };
  if (existing.status === "scheduled" && existing.scheduledAt.getTime() === newAt.getTime()) return { ok: true, alreadyApplied: true };
  if (!APPOINTMENT_TRANSITIONS[existing.status].includes("reschedule")) return { ok: false, reason: "invalid_transition" };
  if (newAt.getTime() < now.getTime() - PAST_SLACK_MS) return { ok: false, reason: "scheduled_in_past" };
  if (!(await withinClinicHours(db, tenantId, newAt, timezone))) return { ok: false, reason: "outside_clinic_hours" };
  const reason = validReason("reschedule", input.reasonCode, input.note);
  if (!reason.ok) return reason;

  const moved = await db.transaction(async (tx) => {
    // Re-activating a cancelled / no-show visit or moving a live one must not land on another visit's slot.
    await lockResourceSlots(tx, tenantId, existing.resourceId!);
    if (await resourceSlotTaken(tx, tenantId, existing.resourceId!, newAt, appointmentId)) return "unavailable" as const;
    const [updated] = await tx
      .update(appointments)
      .set({ scheduledAt: newAt, status: "scheduled", noShowAt: null, cancelledAt: null, statusReasonCode: reason.code, statusReasonNote: reason.note })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId), eq(appointments.status, existing.status), eq(appointments.scheduledAt, existing.scheduledAt)))
      .returning({ id: appointments.id });
    if (!updated) return false;

    await tx.insert(timelineEvents).values({
      tenantId, patientId: existing.patientId, journeyId: existing.journeyId, actorType: "user", actorId,
      eventType: "appointment_rescheduled", relatedEntityType: "appointment", relatedEntityId: appointmentId,
      title: `Appointment rescheduled · ${formatDueForTimeline(newAt, timezone)}`,
      description: `Reason: ${REASON_LABEL.get(reason.code)}${reason.note ? ` · ${reason.note}` : ""}`,
    });

    if (existing.status === "no_show") await resolveNoShowRisk(tx, tenantId, appointmentId, actorId, now);
    if (reason.hospitalAction) {
      await raiseAppointmentRisk(
        tx, tenantId, existing, "hospital_reschedule", actorId,
        `Appointment moved from ${formatDueForTimeline(existing.scheduledAt, timezone)} to ${formatDueForTimeline(newAt, timezone)} (${REASON_LABEL.get(reason.code)}). Tell the patient and confirm the new time.`,
        timezone, now,
      );
    }
    return true;
  });
  if (moved === "unavailable") return { ok: false, reason: "resource_unavailable" };
  if (!moved) {
    const [again] = await db.select({ at: appointments.scheduledAt, status: appointments.status }).from(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.tenantId, tenantId))).limit(1);
    if (again && again.status === "scheduled" && again.at.getTime() === newAt.getTime()) return { ok: true, alreadyApplied: true };
    return { ok: false, reason: "invalid_transition" };
  }

  emitAppointmentEvent({ type: "appointment.rescheduled", tenantId, appointmentId, previousScheduledAt: existing.scheduledAt, scheduledAt: newAt, reasonCode: reason.code, hospitalAction: reason.hospitalAction });
  return { ok: true };
}

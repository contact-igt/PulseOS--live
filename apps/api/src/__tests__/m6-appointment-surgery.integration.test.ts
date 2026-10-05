import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  APPOINTMENT_REASONS,
  APPOINTMENT_TRANSITIONS,
  waitMinutes,
  type AppointmentAction,
  type AppointmentRow,
  type AppointmentStatus,
  type FrontDeskDashboard,
  type JourneyDetailVm,
  type PatientUpcoming,
  type Role,
  type ScheduleResourceVm,
  type TaskRow,
  type TimelineEventVm,
  type TreatmentDefinitionVm,
  type TreatmentRow,
} from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, followUpTypes, journeys, scheduleResources, tasks, timelineEvents, treatmentOpportunities } from "../db/schema.js";
import { onAppointmentEvent, type AppointmentDomainEvent } from "../domain/appointment/appointment-events.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe("appointment transition graph (unit)", () => {
  it("every status offers a bounded set of operations, and Completed is final", () => {
    expect(APPOINTMENT_TRANSITIONS.completed).toEqual([]);
    expect(APPOINTMENT_TRANSITIONS.with_doctor).toEqual(["complete"]);
    expect(APPOINTMENT_TRANSITIONS.scheduled).toContain("check_in");
    expect(APPOINTMENT_TRANSITIONS.checked_in).not.toContain("mark_no_show");
  });

  it("reasons: a no-show can never be 'Hospital reschedule'; hospital-caused reasons are flagged", () => {
    const noShow = APPOINTMENT_REASONS.filter((r) => r.appliesTo.includes("no_show")).map((r) => r.code);
    expect(noShow).toEqual(["unable_to_reach", "patient_no_show", "other"]);
    expect(APPOINTMENT_REASONS.filter((r) => r.hospitalAction).map((r) => r.code).sort()).toEqual(["doctor_unavailable", "hospital_cancelled", "hospital_reschedule"]);
  });

  it("waiting time is derived from real timestamps, never stored", () => {
    const now = new Date("2026-10-01T05:30:00Z");
    // Counted from arrival: the minutes between check-in and "waiting" are still waiting.
    expect(waitMinutes({ status: "waiting", checkedInAt: "2026-10-01T05:16:00Z", waitingStartedAt: "2026-10-01T05:17:00Z" }, now)).toBe(14);
    expect(waitMinutes({ status: "waiting", waitingStartedAt: "2026-10-01T05:17:00Z" }, now)).toBe(13); // legacy row with no check-in time
    expect(waitMinutes({ status: "checked_in", checkedInAt: "2026-10-01T05:25:00Z" }, now)).toBe(5);
    expect(waitMinutes({ status: "with_doctor", checkedInAt: "2026-10-01T05:25:00Z" }, now)).toBeNull();
    expect(waitMinutes({ status: "waiting" }, now)).toBeNull();
  });
});

describe.skipIf(!DEMO_PASSWORD)("M6 appointment lifecycle, resources, risk and surgery (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  let catalog: TreatmentDefinitionVm[];
  let resourceId: string; // Dr (linked to the Doctor login)
  let loginlessId: string; // a doctor with NO login
  const events: AppointmentDomainEvent[] = [];

  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: as(tt, role), ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(52000000 + ++n * 29).padStart(8, "0")}`;
  // Future instants are spread one distinct minute apart: the same doctor cannot hold two visits in one minute.
  let slotSeq = 0;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000 + (h > 0 ? ++slotSeq * 60_000 : 0)).toISOString();
  const cataract = () => catalog.find((d) => d.key === "CATARACT_SURGERY")!;

  async function newJourney(tt: TestTenant = t) {
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "M6 Patient", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  async function book(opts: { tt?: TestTenant; doctorId?: string; at?: string } = {}) {
    const tt = opts.tt ?? t;
    const { patientId, journeyId } = await newJourney(tt);
    const res = await call(tt, "FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: tt.branchId, doctorId: opts.doctorId ?? resourceId, scheduledAt: opts.at ?? inHours(24), reason: "Consultation" });
    expect(res.statusCode).toBe(201);
    return res.json() as AppointmentRow;
  }
  const act = (id: string, action: AppointmentAction, extra: object = {}, role: Role = "FRONT_DESK", tt: TestTenant = t) => call(tt, role, "PATCH", `/appointments/${id}/action`, { action, ...extra });
  const toWithDoctor = async (id: string) => {
    for (const a of ["check_in", "mark_waiting", "send_to_doctor"] as const) expect((await act(id, a)).statusCode).toBe(200);
  };
  const row = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;
  const timeline = async (patientId: string, tt: TestTenant = t) => (await call(tt, "FRONT_DESK", "GET", `/patients/${patientId}/timeline`)).json() as TimelineEventVm[];
  const lines = async (patientId: string, eventType: string) => (await timeline(patientId)).filter((e) => e.eventType === eventType);
  const openRisk = async (appointmentId: string) =>
    db.select().from(tasks).where(and(eq(tasks.appointmentId, appointmentId), sql`${tasks.status} in ('pending', 'in_progress')`));
  const followUpTypeId = async (key: string) => (await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, t.tenantId), eq(followUpTypes.key, key))))[0]!.id;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!, { connectorMode: "FIXTURE" });
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    catalog = (await call(t, "HOSPITAL_ADMIN", "GET", "/treatment-catalog")).json() as TreatmentDefinitionVm[];
    resourceId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
    const created = await call(t, "HOSPITAL_ADMIN", "POST", "/resources", { name: "Dr Visiting Surgeon" });
    loginlessId = (created.json() as ScheduleResourceVm).id;
    onAppointmentEvent((e) => void events.push(e));
  });

  afterAll(async () => {
    for (const tt of [t, other]) {
      await db.execute(sql`delete from tasks where tenant_id = ${tt.tenantId}::uuid`);
      await db.execute(sql`delete from treatment_opportunities where tenant_id = ${tt.tenantId}::uuid`);
      await db.execute(sql`delete from appointments where tenant_id = ${tt.tenantId}::uuid`);
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  // ------------------------------------------------------------------ state machine
  describe("state machine (server-side)", () => {
    it("accepts exactly the operations in the shared graph from every status, and rejects the rest", async () => {
      const actions: AppointmentAction[] = ["confirm", "check_in", "mark_waiting", "send_to_doctor", "mark_no_show", "cancel"];
      const target: Record<AppointmentAction, AppointmentStatus> = { confirm: "confirmed", check_in: "checked_in", mark_waiting: "waiting", send_to_doctor: "with_doctor", mark_no_show: "no_show", cancel: "cancelled" };
      for (const status of Object.keys(APPOINTMENT_TRANSITIONS) as AppointmentStatus[]) {
        for (const action of actions) {
          const a = await book();
          await db.update(appointments).set({ status }).where(eq(appointments.id, a.id));
          const res = await act(a.id, action, action === "cancel" ? { reasonCode: "patient_requested" } : {});
          const allowed = APPOINTMENT_TRANSITIONS[status].includes(action);
          const repeat = status === target[action]; // pressing the same button again is a no-op, not an error
          expect({ status, action, ok: res.statusCode === 200 }).toEqual({ status, action, ok: allowed || repeat });
          if (!allowed && !repeat) expect([409]).toContain(res.statusCode);
          expect((await row(a.id)).status).toBe(allowed ? target[action] : status);
        }
      }
    }, 120_000);

    it("a Booked appointment checks in directly, stamps checkedInAt and writes one 'Checked in' line", async () => {
      const a = await book();
      const res = await act(a.id, "check_in");
      expect(res.json()).toMatchObject({ ok: true, status: "checked_in" });
      const r = await row(a.id);
      expect(r.checkedInAt).toBeTruthy();
      expect(Date.now() - r.checkedInAt!.getTime()).toBeLessThan(60_000);
      const l = await lines(a.patientId, "appointment_checked_in");
      expect(l).toHaveLength(1);
      expect(l[0]!.title).toMatch(/^Checked in · \d{1,2}:\d{2} (am|pm)$/);
    });

    it("double Check In is safe: current state returned, one timestamp, one Timeline line", async () => {
      const a = await book();
      const first = await act(a.id, "check_in");
      const stamp = (await row(a.id)).checkedInAt!.getTime();
      const second = await act(a.id, "check_in");
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ status: "checked_in", alreadyApplied: true });
      expect((await row(a.id)).checkedInAt!.getTime()).toBe(stamp);
      expect(await lines(a.patientId, "appointment_checked_in")).toHaveLength(1);
    });

    it("two people pressing Check In at once end in one legal state with one event", async () => {
      const a = await book();
      const [x, y] = await Promise.all([act(a.id, "check_in"), act(a.id, "check_in", {}, "PATIENT_COORDINATOR")]);
      expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
      expect((await row(a.id)).status).toBe("checked_in");
      expect(await lines(a.patientId, "appointment_checked_in")).toHaveLength(1);
    });

    it("Waiting stamps waitingStartedAt; the Front Desk derives the minutes from the timestamps", async () => {
      const a = await book({ at: new Date().toISOString() });
      await act(a.id, "check_in");
      await act(a.id, "mark_waiting");
      const r = await row(a.id);
      expect(r.waitingStartedAt).toBeTruthy();
      // Arrived 14 minutes ago: nothing is "stored" — the value follows the clock.
      await db.update(appointments).set({ checkedInAt: new Date(Date.now() - 14 * 60_000), waitingStartedAt: new Date(Date.now() - 14 * 60_000) }).where(eq(appointments.id, a.id));
      const fd = (await call(t, "FRONT_DESK", "GET", "/front-desk")).json() as FrontDeskDashboard;
      const queued = fd.waitingQueue.find((q) => q.id === a.id)!;
      expect(queued).toBeTruthy();
      expect(waitMinutes(queued)).toBeGreaterThanOrEqual(14);
      expect(waitMinutes(queued)).toBeLessThan(16);
    });

    it("With doctor stamps consultationStartedAt and writes 'Consultation started'", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      expect((await row(a.id)).consultationStartedAt).toBeTruthy();
      const l = await lines(a.patientId, "appointment_with_doctor");
      expect(l).toHaveLength(1);
      expect(l[0]!.title).toMatch(/^Consultation started · /);
    });

    it("an unknown action or a malformed body is a 400, never a 500", async () => {
      const a = await book();
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/action`, { action: "explode" })).statusCode).toBe(400);
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/not-a-uuid/action`, { action: "check_in" })).statusCode).toBe(404);
    });
  });

  // ------------------------------------------------------------------ completion
  describe("consultation completion", () => {
    it("No follow-up: completes, stamps completedAt, one line, creates nothing and leaves the Journey alone", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const [before] = await db.select().from(journeys).where(eq(journeys.id, a.journeyId));
      const res = await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "none" }, note: "Wants to think about it" });
      expect(res.statusCode).toBe(200);
      const r = await row(a.id);
      expect(r.status).toBe("completed");
      expect(r.completedAt).toBeTruthy();
      const l = await lines(a.patientId, "appointment_completed");
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ description: "Wants to think about it" });
      expect(l[0]!.title).toMatch(/^Consultation completed · /);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, a.journeyId))).toHaveLength(0);
      const [after] = await db.select().from(journeys).where(eq(journeys.id, a.journeyId));
      expect({ stage: after!.stage, source: after!.source, owner: after!.ownerUserId, sourceId: after!.sourceId }).toEqual({ stage: before!.stage, source: before!.source, owner: before!.ownerUserId, sourceId: before!.sourceId });
    });

    it("a bare complete (no body) still just completes the visit", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`)).statusCode).toBe(200);
      expect((await row(a.id)).status).toBe("completed");
    });

    it("Create follow-up: completes AND creates the Task with its Timeline line, together", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const typeId = await followUpTypeId("appointment_followup");
      const res = await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "follow_up", followUp: { followUpTypeId: typeId, dueAt: inHours(24), note: "Review in a week" } } });
      expect(res.statusCode).toBe(200);
      const { followUpTaskId } = res.json() as { followUpTaskId: string };
      expect(followUpTaskId).toBeTruthy();
      const [task] = await db.select().from(tasks).where(eq(tasks.id, followUpTaskId));
      expect(task).toMatchObject({ journeyId: a.journeyId, followUpTypeId: typeId, status: "pending", notes: "Review in a week" });
      expect((await timeline(a.patientId)).map((e) => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/^Consultation completed/), "Follow-up scheduled · Appointment Follow-up"]));
      const detail = (await call(t, "FRONT_DESK", "GET", `/journeys/${a.journeyId}`)).json() as JourneyDetailVm;
      expect(detail.journey.nextTask?.id).toBe(followUpTaskId);
    });

    it("a refused follow-up refuses the whole completion: the visit stays With doctor and nothing is written", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const typeId = await followUpTypeId("appointment_followup");
      const res = await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "follow_up", followUp: { followUpTypeId: typeId, dueAt: inHours(-5) } } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "due_in_past" });
      expect((await row(a.id)).status).toBe("with_doctor");
      expect((await row(a.id)).completedAt).toBeNull();
      expect(await lines(a.patientId, "appointment_completed")).toHaveLength(0);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, a.journeyId))).toHaveLength(0);
      // ...and the same visit can still be completed once the follow-up is valid.
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "follow_up", followUp: { followUpTypeId: typeId, dueAt: inHours(30) } } })).statusCode).toBe(200);
    });

    it("completing twice (even at once) completes once and creates one follow-up", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const typeId = await followUpTypeId("general_followup");
      const body = { next: { kind: "follow_up", followUp: { followUpTypeId: typeId, dueAt: inHours(48) } } };
      const [x, y] = await Promise.all([call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, body), call(t, "PATIENT_COORDINATOR", "PATCH", `/appointments/${a.id}/complete`, body)]);
      expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
      expect([x.json(), y.json()].filter((r) => r.alreadyApplied)).toHaveLength(1);
      expect(await lines(a.patientId, "appointment_completed")).toHaveLength(1);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, a.journeyId))).toHaveLength(1);
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`)).json()).toMatchObject({ alreadyApplied: true });
    });

    it("complete is refused unless the patient is with the doctor", async () => {
      const a = await book();
      const res = await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "not_with_doctor" });
    });

    it("Schedule surgery: completes the visit and schedules the procedure through the treatment lifecycle", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const at = inHours(24 * 10);
      const res = await call(t, "PATIENT_COORDINATOR", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "surgery", surgery: { treatmentDefinitionId: cataract().id, scheduledAt: at, resourceId: loginlessId, branchId: t.branchId, note: "Right eye" } } });
      expect(res.statusCode).toBe(200);
      const { treatmentId } = res.json() as { treatmentId: string };
      const [tr] = await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.id, treatmentId));
      expect(tr).toMatchObject({ status: "SCHEDULED", journeyId: a.journeyId, treatmentDefinitionId: cataract().id, scheduledResourceId: loginlessId, scheduledBranchId: t.branchId, scheduleNote: "Right eye" });
      expect(tr!.plannedDate!.toISOString()).toBe(at);
      expect((await row(a.id)).status).toBe("completed");
    });

    it("a refused surgery (foreign doctor) refuses the completion; Front Desk, who cannot manage treatments, is refused too", async () => {
      const a = await book();
      await toWithDoctor(a.id);
      const foreignResource = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, other.userIds.DOCTOR!)))[0]!.id;
      const surgery = { treatmentDefinitionId: cataract().id, scheduledAt: inHours(240), resourceId: foreignResource, branchId: t.branchId };
      const bad = await call(t, "PATIENT_COORDINATOR", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "surgery", surgery } });
      expect(bad.statusCode).toBe(422);
      expect(bad.json()).toMatchObject({ error: "resource_invalid" });
      const noRight = await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/complete`, { next: { kind: "surgery", surgery: { ...surgery, resourceId: loginlessId } } });
      expect(noRight.statusCode).toBe(403);
      expect((await row(a.id)).status).toBe("with_doctor");
      expect(await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, a.journeyId))).toHaveLength(0);
    });

    it("a Doctor completes only a visit that is with them; another hospital cannot touch the appointment at all", async () => {
      // A visit with a different doctor (a resource with no login): the logged-in doctor may not complete it.
      const theirs = await book({ doctorId: loginlessId });
      await toWithDoctor(theirs.id);
      expect((await call(t, "DOCTOR", "PATCH", `/appointments/${theirs.id}/complete`)).statusCode).toBe(403);
      expect((await row(theirs.id)).status).toBe("with_doctor");
      // Their own visit: allowed (and they still cannot move it through check-in).
      const a = await book();
      await toWithDoctor(a.id);
      expect((await act(a.id, "check_in", undefined, "DOCTOR")).statusCode).toBe(403);
      expect((await call(other, "HOSPITAL_ADMIN", "PATCH", `/appointments/${a.id}/complete`)).statusCode).toBe(404);
      expect((await act(a.id, "cancel", { reasonCode: "other" }, "HOSPITAL_ADMIN", other)).statusCode).toBe(404);
      expect((await call(other, "HOSPITAL_ADMIN", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: inHours(30), reasonCode: "other" })).statusCode).toBe(404);
      expect((await row(a.id)).status).toBe("with_doctor");
    });
  });

  // ------------------------------------------------------------------ doctor / resource
  describe("doctor / resource model", () => {
    it("a doctor with no login can be booked and shows by name on every appointment view", async () => {
      const a = await book({ doctorId: loginlessId });
      expect(a).toMatchObject({ doctorId: loginlessId, doctorName: "Dr Visiting Surgeon" });
      const [r] = await db.select().from(appointments).where(eq(appointments.id, a.id));
      expect(r!.doctorUserId).toBeNull();
      const list = (await call(t, "FRONT_DESK", "GET", `/appointments?doctorId=${loginlessId}`)).json() as AppointmentRow[];
      expect(list.map((x) => x.id)).toContain(a.id);
      const detail = (await call(t, "FRONT_DESK", "GET", `/journeys/${a.journeyId}`)).json() as JourneyDetailVm;
      expect(detail.appointments[0]!.doctorName).toBe("Dr Visiting Surgeon");
      const lookups = (await call(t, "FRONT_DESK", "GET", "/lookups")).json() as { doctors: { id: string; name: string }[] };
      expect(lookups.doctors.map((d) => d.id)).toEqual(expect.arrayContaining([resourceId, loginlessId]));
    });

    it("a Doctor user automatically has a linked resource, and that doctor's own views still follow the link", async () => {
      const a = await book({ doctorId: resourceId });
      const [r] = await db.select().from(appointments).where(eq(appointments.id, a.id));
      expect(r!.doctorUserId).toBe(t.userIds.DOCTOR);
      const mine = (await call(t, "DOCTOR", "GET", "/dashboard/doctor")).json() as { todaysAppointments?: unknown[] };
      expect(mine).toBeTruthy();
    });

    it("another hospital's doctor, an archived doctor, and a stranger id are all refused", async () => {
      const foreign = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, other.userIds.DOCTOR!)))[0]!.id;
      const { patientId, journeyId } = await newJourney();
      const base = { patientId, journeyId, branchId: t.branchId, scheduledAt: inHours(30) };
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, doctorId: foreign })).statusCode).toBe(404);
      const archived = (await call(t, "HOSPITAL_ADMIN", "POST", "/resources", { name: "Dr Retired" })).json() as ScheduleResourceVm;
      await call(t, "HOSPITAL_ADMIN", "PATCH", `/resources/${archived.id}`, { isActive: false });
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, doctorId: archived.id })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, doctorId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
      // The DB refuses a cross-hospital resource even if a service forgot to check.
      await expect(db.insert(appointments).values({ tenantId: t.tenantId, patientId, journeyId, branchId: t.branchId, resourceId: foreign, scheduledAt: new Date() })).rejects.toThrow();
    });

    it("only an Admin manages resources; a department must be this hospital's", async () => {
      expect((await call(t, "FRONT_DESK", "POST", "/resources", { name: "Dr X" })).statusCode).toBe(403);
      expect((await call(t, "FRONT_DESK", "GET", "/resources")).statusCode).toBe(200);
      const foreignDept = ((await call(other, "HOSPITAL_ADMIN", "GET", "/departments")).json() as { id: string }[])[0]!.id;
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/resources", { name: "Dr Y", departmentId: foreignDept })).statusCode).toBe(422);
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/resources", { name: "   " })).statusCode).toBe(400);
      const list = (await call(t, "HOSPITAL_ADMIN", "GET", "/resources")).json() as ScheduleResourceVm[];
      expect(list.find((r) => r.id === loginlessId)).toMatchObject({ hasLogin: false, isActive: true });
      expect(list.find((r) => r.id === resourceId)).toMatchObject({ hasLogin: true });
    });
  });

  // ------------------------------------------------------------------ reschedule / cancel / no-show / risk
  describe("reschedule, cancel, no-show and Appointment Risk", () => {
    it("reschedule needs a future time and a reason; the reason is stored and the Timeline gets one line", async () => {
      const a = await book();
      const url = `/appointments/${a.id}/reschedule`;
      expect((await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(-3), reasonCode: "patient_requested" })).statusCode).toBe(422);
      expect((await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(30) })).statusCode).toBe(400);
      expect((await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(30), reasonCode: "patient_no_show" })).statusCode).toBe(422); // not a reschedule reason
      const when = "2027-02-10T05:30:00.000Z";
      const ok = await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: when, reasonCode: "timing_conflict", note: "Has an exam" });
      expect(ok.statusCode).toBe(200);
      const r = await row(a.id);
      expect(r.scheduledAt.toISOString()).toBe(when);
      expect(r).toMatchObject({ status: "scheduled", statusReasonCode: "timing_conflict", statusReasonNote: "Has an exam" });
      const l = await lines(a.patientId, "appointment_rescheduled");
      expect(l).toHaveLength(1);
      expect(l[0]!.title).toContain("11:00 am"); // hospital clock (IST), not UTC
      expect(l[0]!.description).toBe("Reason: Timing conflict · Has an exam");
      // A repeated click for the same time changes nothing.
      expect((await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: when, reasonCode: "timing_conflict" })).json()).toMatchObject({ alreadyApplied: true });
      expect(await lines(a.patientId, "appointment_rescheduled")).toHaveLength(1);
      const list = (await call(t, "FRONT_DESK", "GET", `/appointments?journeyId=${a.journeyId}`)).json() as AppointmentRow[];
      expect(list[0]).toMatchObject({ scheduledAt: when, statusReason: { code: "timing_conflict", label: "Timing conflict" } });
    });

    it("a visit that already happened or is in progress cannot be rescheduled", async () => {
      const a = await book();
      await act(a.id, "check_in");
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: inHours(30), reasonCode: "other" })).statusCode).toBe(409);
    });

    it("a hospital-caused reschedule raises ONE Appointment Risk task; a patient-requested one raises none", async () => {
      const patientChoice = await book();
      await call(t, "FRONT_DESK", "PATCH", `/appointments/${patientChoice.id}/reschedule`, { scheduledAt: inHours(48), reasonCode: "patient_requested" });
      expect(await openRisk(patientChoice.id)).toHaveLength(0);

      const a = await book();
      const url = `/appointments/${a.id}/reschedule`;
      await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(48), reasonCode: "doctor_unavailable" });
      await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(72), reasonCode: "hospital_reschedule" }); // still unresolved: no second task
      const risks = await openRisk(a.id);
      expect(risks).toHaveLength(1);
      expect(risks[0]).toMatchObject({ riskReason: "hospital_reschedule", priority: "high", journeyId: a.journeyId, status: "pending" });
      const all = (await call(t, "FRONT_DESK", "GET", "/tasks?view=all")).json() as TaskRow[];
      expect(all.find((x) => x.id === risks[0]!.id)).toMatchObject({ typeLabel: "Appointment Risk", followUpTypeKey: "appointment_risk" });
      // Once handled, a later hospital change raises a fresh one.
      await call(t, "FRONT_DESK", "PATCH", `/tasks/${risks[0]!.id}/complete`);
      await call(t, "FRONT_DESK", "PATCH", url, { scheduledAt: inHours(96), reasonCode: "doctor_unavailable" });
      expect(await openRisk(a.id)).toHaveLength(1);
    });

    it("cancel needs a reason; it is stored on the visit and in the Timeline; the Journey is left open", async () => {
      const a = await book();
      expect((await act(a.id, "cancel")).statusCode).toBe(422);
      expect((await act(a.id, "cancel", { reasonCode: "patient_no_show" })).statusCode).toBe(422); // not a cancel reason
      const ok = await act(a.id, "cancel", { reasonCode: "patient_requested", note: "Travelling" });
      expect(ok.statusCode).toBe(200);
      const r = await row(a.id);
      expect(r).toMatchObject({ status: "cancelled", statusReasonCode: "patient_requested", statusReasonNote: "Travelling" });
      expect(r.cancelledAt).toBeTruthy();
      const l = await lines(a.patientId, "appointment_cancelled");
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ title: "Appointment cancelled", description: "Reason: Patient requested · Travelling" });
      expect(await openRisk(a.id)).toHaveLength(0);
      const [j] = await db.select({ stage: journeys.stage }).from(journeys).where(eq(journeys.id, a.journeyId));
      expect(j!.stage).not.toBe("lost");
      expect((await act(a.id, "cancel", { reasonCode: "patient_requested" })).json()).toMatchObject({ alreadyApplied: true });
      expect(await lines(a.patientId, "appointment_cancelled")).toHaveLength(1);
    });

    it("a hospital-caused cancellation raises an Appointment Risk task", async () => {
      const a = await book();
      await act(a.id, "cancel", { reasonCode: "doctor_unavailable" });
      const risks = await openRisk(a.id);
      expect(risks).toHaveLength(1);
      expect(risks[0]).toMatchObject({ riskReason: "hospital_cancel" });
      expect(risks[0]!.notes).toContain("cancelled by the hospital");
    });

    it("no-show: stores time and reason, writes one line, raises exactly one Appointment Risk, even when repeated", async () => {
      const a = await book();
      const [x, y] = await Promise.all([act(a.id, "mark_no_show"), act(a.id, "mark_no_show", {}, "PATIENT_COORDINATOR")]);
      expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
      const r = await row(a.id);
      expect(r).toMatchObject({ status: "no_show", statusReasonCode: "patient_no_show" });
      expect(r.noShowAt).toBeTruthy();
      expect(await lines(a.patientId, "appointment_no_show")).toHaveLength(1);
      const risks = await openRisk(a.id);
      expect(risks).toHaveLength(1);
      expect(risks[0]).toMatchObject({ riskReason: "no_show", reason: "no_show", status: "pending", priority: "high" });
      // It lands in My Work's Appointment Risk bucket.
      const counts = (await call(t, "FRONT_DESK", "GET", "/tasks/counts")).json() as { appointmentRisk: number };
      expect(counts.appointmentRisk).toBeGreaterThanOrEqual(1);
      const bucket = (await call(t, "FRONT_DESK", "GET", "/tasks?view=appointment_risk")).json() as TaskRow[];
      expect(bucket.map((b) => b.id)).toContain(risks[0]!.id);
      // The Front Desk flags it.
      const fd = (await call(t, "FRONT_DESK", "GET", "/front-desk")).json() as FrontDeskDashboard;
      expect(fd.atRisk).toBeDefined();
    });

    it("rebooking a no-show resolves its recovery task, and a later no-show raises a new one", async () => {
      const a = await book();
      await act(a.id, "mark_no_show");
      const [first] = await openRisk(a.id);
      expect(first).toBeTruthy();
      expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: inHours(72), reasonCode: "patient_requested" })).statusCode).toBe(200);
      expect(await openRisk(a.id)).toHaveLength(0);
      const [done] = await db.select().from(tasks).where(eq(tasks.id, first!.id));
      expect(done).toMatchObject({ status: "completed" });
      expect((await row(a.id))).toMatchObject({ status: "scheduled", noShowAt: null });
      await act(a.id, "mark_no_show");
      expect(await openRisk(a.id)).toHaveLength(1);
    });

    it("Appointment Risk works even if the hospital archived that follow-up type", async () => {
      await db.update(followUpTypes).set({ isActive: false }).where(and(eq(followUpTypes.tenantId, t.tenantId), eq(followUpTypes.key, "appointment_risk")));
      try {
        const a = await book();
        await act(a.id, "mark_no_show");
        expect(await openRisk(a.id)).toHaveLength(1);
      } finally {
        await db.update(followUpTypes).set({ isActive: true }).where(and(eq(followUpTypes.tenantId, t.tenantId), eq(followUpTypes.key, "appointment_risk")));
      }
    });

    it("publishes domain events after the change, ready for the reminder engine", async () => {
      events.length = 0;
      const a = await book();
      await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: inHours(60), reasonCode: "doctor_unavailable" });
      await act(a.id, "cancel", { reasonCode: "hospital_cancelled" });
      expect(events.map((e) => e.type)).toEqual(["appointment.booked", "appointment.rescheduled", "appointment.cancelled"]);
      expect(events[1]).toMatchObject({ appointmentId: a.id, reasonCode: "doctor_unavailable", hospitalAction: true });
    });
  });

  // ------------------------------------------------------------------ surgery
  describe("surgery scheduling", () => {
    const schedule = (journeyId: string, over: Record<string, unknown> = {}, role: Role = "PATIENT_COORDINATOR") =>
      call(t, role, "POST", `/journeys/${journeyId}/surgery`, { treatmentDefinitionId: cataract().id, scheduledAt: "2027-03-12T04:00:00.000Z", resourceId: loginlessId, branchId: t.branchId, note: "Right eye", ...over });

    it("creates the treatment, walks it through the transition graph to SCHEDULED, and stores when / who / where", async () => {
      const { journeyId, patientId } = await newJourney();
      const res = await schedule(journeyId);
      expect(res.statusCode).toBe(201);
      const { treatmentId } = res.json() as { treatmentId: string };
      const [tr] = await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.id, treatmentId));
      expect(tr).toMatchObject({ status: "SCHEDULED", treatmentLabel: cataract().label, scheduledResourceId: loginlessId, scheduledBranchId: t.branchId, scheduleNote: "Right eye", patientId });
      expect(tr!.plannedDate!.toISOString()).toBe("2027-03-12T04:00:00.000Z");
      expect(tr!.decisionDate).toBeTruthy(); // it passed through ACCEPTED, not around it
      const l = (await timeline(patientId)).filter((e) => e.eventType === "surgery_scheduled");
      expect(l).toHaveLength(1);
      expect(l[0]!.title).toBe(`Surgery scheduled · ${cataract().label}`);
      expect(l[0]!.description).toContain("9:30 am"); // 04:00Z = 09:30 IST
      expect(l[0]!.description).toContain("Dr Visiting Surgeon");
      // Only the one meaningful line: no intermediate "accepted" noise.
      expect((await timeline(patientId)).filter((e) => e.eventType === "treatment_status_changed")).toHaveLength(0);
    });

    it("reuses the Journey's advised procedure instead of creating a second record", async () => {
      const { journeyId, patientId } = await newJourney();
      const [advised] = await db.insert(treatmentOpportunities).values({ tenantId: t.tenantId, patientId, journeyId, treatmentLabel: cataract().label, treatmentDefinitionId: cataract().id, status: "ADVISED", estimatedValue: 45000 }).returning();
      const res = await schedule(journeyId);
      expect((res.json() as { treatmentId: string }).treatmentId).toBe(advised!.id);
      const all = await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId));
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ status: "SCHEDULED", estimatedValue: 45000 });
    });

    it("scheduling the same procedure again is refused, and concurrent attempts create one record", async () => {
      const { journeyId } = await newJourney();
      const [x, y] = await Promise.all([schedule(journeyId), schedule(journeyId, {}, "HOSPITAL_ADMIN")]);
      expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
      expect(await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId))).toHaveLength(1);
      expect(await lines((await db.select({ p: journeys.patientId }).from(journeys).where(eq(journeys.id, journeyId)))[0]!.p, "surgery_scheduled")).toHaveLength(1);
      const again = await schedule(journeyId);
      expect(again.json()).toMatchObject({ error: "surgery_already_scheduled" });
    });

    it("validates everything it points at: past time, other hospital's procedure/doctor/branch/journey, bad shapes", async () => {
      const { journeyId } = await newJourney();
      expect((await schedule(journeyId, { scheduledAt: inHours(-24) })).json()).toMatchObject({ error: "scheduled_in_past" });
      const foreignDef = ((await call(other, "HOSPITAL_ADMIN", "GET", "/treatment-catalog")).json() as TreatmentDefinitionVm[])[0]!;
      expect((await schedule(journeyId, { treatmentDefinitionId: foreignDef.id })).json()).toMatchObject({ error: "treatment_invalid" });
      expect((await schedule(journeyId, { branchId: other.branchId })).json()).toMatchObject({ error: "branch_invalid" });
      const foreignResource = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, other.userIds.DOCTOR!)))[0]!.id;
      expect((await schedule(journeyId, { resourceId: foreignResource })).json()).toMatchObject({ error: "resource_invalid" });
      const foreignJourney = (await newJourney(other)).journeyId;
      expect((await schedule(foreignJourney)).statusCode).toBe(404);
      expect((await schedule(journeyId, { resourceId: "nope" })).statusCode).toBe(400);
      expect((await schedule(journeyId, { note: "x".repeat(501) })).statusCode).toBe(400);
      expect(await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId))).toHaveLength(0);
    });

    it("needs the existing treatment-management permission: Front Desk and Doctor are refused", async () => {
      const { journeyId } = await newJourney();
      expect((await schedule(journeyId, {}, "FRONT_DESK")).statusCode).toBe(403);
      expect((await schedule(journeyId, {}, "DOCTOR")).statusCode).toBe(403);
      expect((await schedule(journeyId, {}, "HOSPITAL_ADMIN")).statusCode).toBe(201);
    });

    it("the same record shows in Treatments, the Journey and Patient 360 Upcoming, with its doctor and branch", async () => {
      const { journeyId, patientId } = await newJourney();
      const { treatmentId } = (await schedule(journeyId, { scheduledAt: inHours(24 * 40) })).json() as { treatmentId: string };
      const list = (await call(t, "HOSPITAL_ADMIN", "GET", "/treatments?status=SCHEDULED")).json() as TreatmentRow[];
      expect(list.find((x) => x.id === treatmentId)).toMatchObject({ status: "SCHEDULED", doctorName: "Dr Visiting Surgeon", resourceName: "Dr Visiting Surgeon", branchName: "Test Branch", scheduleNote: "Right eye" });
      expect(((await call(t, "HOSPITAL_ADMIN", "GET", `/treatments?doctorId=${loginlessId}`)).json() as TreatmentRow[]).map((x) => x.id)).toContain(treatmentId);
      const detail = (await call(t, "PATIENT_COORDINATOR", "GET", `/journeys/${journeyId}`)).json() as JourneyDetailVm;
      expect(detail.treatments!.find((x) => x.id === treatmentId)).toMatchObject({ status: "SCHEDULED", resourceName: "Dr Visiting Surgeon" });
      const up = (await call(t, "HOSPITAL_ADMIN", "GET", `/patients/${patientId}/upcoming`)).json() as PatientUpcoming;
      expect(up.items.find((i) => i.kind === "treatment")).toMatchObject({ id: treatmentId, status: "SCHEDULED", personName: "Dr Visiting Surgeon" });
      const [j] = await db.select({ stage: journeys.stage }).from(journeys).where(eq(journeys.id, journeyId));
      expect(j!.stage).toBe("scheduled");
    });

    it("reschedule moves it (one line); cancel is the normal CANCELLED transition and drops it from Upcoming", async () => {
      const { journeyId, patientId } = await newJourney();
      const { treatmentId } = (await schedule(journeyId, { scheduledAt: inHours(24 * 20) })).json() as { treatmentId: string };
      const moved = await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/schedule`, { scheduledAt: "2027-04-02T03:30:00.000Z", resourceId });
      expect(moved.statusCode).toBe(200);
      const [tr] = await db.select().from(treatmentOpportunities).where(eq(treatmentOpportunities.id, treatmentId));
      expect(tr).toMatchObject({ status: "SCHEDULED", scheduledResourceId: resourceId });
      expect(tr!.plannedDate!.toISOString()).toBe("2027-04-02T03:30:00.000Z");
      const l = (await timeline(patientId)).filter((e) => e.eventType === "surgery_rescheduled");
      expect(l).toHaveLength(1);
      expect(l[0]!.description).toContain("9:00 am");
      expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/schedule`, { scheduledAt: "2027-04-02T03:30:00.000Z", resourceId })).json()).toMatchObject({ alreadyApplied: true });

      expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/status`, { status: "CANCELLED" })).statusCode).toBe(200);
      expect((await timeline(patientId)).some((e) => e.title === `Surgery cancelled · ${cataract().label}`)).toBe(true);
      const up = (await call(t, "HOSPITAL_ADMIN", "GET", `/patients/${patientId}/upcoming`)).json() as PatientUpcoming;
      expect(up.items.some((i) => i.kind === "treatment")).toBe(false);
      expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/schedule`, { scheduledAt: inHours(100) })).statusCode).toBe(409);
    });

    it("a completed hospital procedure for another tenant can never be rescheduled from here", async () => {
      const { journeyId } = await newJourney();
      const { treatmentId } = (await schedule(journeyId, { scheduledAt: inHours(24 * 21) })).json() as { treatmentId: string };
      expect((await call(other, "HOSPITAL_ADMIN", "PATCH", `/treatments/${treatmentId}/schedule`, { scheduledAt: inHours(24 * 22) })).statusCode).toBe(404);
    });
  });

  it("events written for an appointment stay in the hospital's own tenant (no timeline rows leak across hospitals)", async () => {
    const a = await book();
    await act(a.id, "check_in");
    const rows = await db.select({ tenantId: timelineEvents.tenantId }).from(timelineEvents).where(eq(timelineEvents.patientId, a.patientId));
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([t.tenantId]));
  });
});

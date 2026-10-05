import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, FollowUpTypeVm, JourneyDetailVm, Role, TaskCounts, TaskRow, TimelineEventVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { followUpTypes, journeys, scheduleResources, tasks, timelineEvents } from "../db/schema.js";
import { deriveNextAction } from "../domain/task/task.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const TZ = "Asia/Kolkata";

describe("Next Action derivation (unit)", () => {
  const now = new Date("2026-10-01T12:00:00.000Z"); // 17:30 IST on 1 Oct
  const t = (id: string, dueAt: string, priority: "normal" | "high" = "normal") => ({ id, dueAt: new Date(dueAt), priority });

  it("overdue first, then today, then the earliest upcoming — by the hospital's day", () => {
    const overdue = t("overdue", "2026-09-30T05:00:00Z");
    const today = t("today", "2026-10-01T15:00:00Z"); // 20:30 IST, still 1 Oct
    const upcoming = t("up", "2026-10-02T05:30:00Z");
    expect(deriveNextAction([upcoming, today, overdue], now, TZ)).toMatchObject({ task: { id: "overdue" }, bucket: "overdue" });
    expect(deriveNextAction([upcoming, today], now, TZ)).toMatchObject({ task: { id: "today" }, bucket: "today" });
    expect(deriveNextAction([t("far", "2026-10-09T05:30:00Z"), upcoming], now, TZ)).toMatchObject({ task: { id: "up" }, bucket: "upcoming" });
    expect(deriveNextAction([], now, TZ)).toBeNull();
  });

  it("a task due late tonight in India is 'today' even when it is already tomorrow in UTC", () => {
    expect(deriveNextAction([t("late", "2026-10-01T19:00:00Z")], now, TZ)?.bucket).toBe("upcoming"); // 00:30 IST on 2 Oct
    expect(deriveNextAction([t("late", "2026-10-01T18:00:00Z")], now, TZ)?.bucket).toBe("today"); // 23:30 IST on 1 Oct
  });

  it("within a bucket high priority wins, then the earliest due; an overdue normal beats an upcoming high", () => {
    const a = t("a", "2026-09-29T05:00:00Z");
    const b = t("b", "2026-09-30T05:00:00Z", "high");
    expect(deriveNextAction([a, b], now, TZ)?.task.id).toBe("b");
    expect(deriveNextAction([t("x", "2026-10-05T05:00:00Z", "high"), a], now, TZ)?.task.id).toBe("a");
  });
});

describe.skipIf(!DEMO_PASSWORD)("follow-up types, Add Follow-up, Next Action, booking (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: as(tt, role), ...(payload ? { payload } : {}) });
  const phone = () => `+9195${String(41000000 + ++n * 23).padStart(8, "0")}`;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const types = async (tt: TestTenant, role: Role = "HOSPITAL_ADMIN", q = "") => (await call(tt, role, "GET", `/followup-types${q}`)).json() as FollowUpTypeVm[];
  const typeId = async (tt: TestTenant, key: string) => (await types(tt, "HOSPITAL_ADMIN", "?includeInactive=true")).find((x) => x.key === key)!.id;
  async function newJourney(tt: TestTenant, extra: Record<string, unknown> = {}) {
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Followup Test", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {}, ...extra });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  const detail = async (tt: TestTenant, role: Role, id: string) => (await call(tt, role, "GET", `/journeys/${id}`)).json() as JourneyDetailVm;
  const timelineOf = async (tt: TestTenant, patientId: string) => (await call(tt, "FRONT_DESK", "GET", `/patients/${patientId}/timeline`)).json() as TimelineEventVm[];
  const addFollowUp = (tt: TestTenant, role: Role, journeyId: string, body: object) => call(tt, role, "POST", `/journeys/${journeyId}/follow-ups`, body);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!, { connectorMode: "FIXTURE" });
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, other]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
  });

  afterAll(async () => {
    for (const tt of [t, other]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  describe("follow-up types (configuration)", () => {
    it("every hospital starts with the five defaults, mapped onto stable task types", async () => {
      const list = await types(t);
      expect(list.map((x) => x.label)).toEqual(["Callback", "Appointment Follow-up", "Appointment Risk", "General Follow-up", "Surgery Follow-up"]);
      expect(list.map((x) => x.key)).toEqual(["callback", "appointment_followup", "appointment_risk", "general_followup", "surgery_followup"]);
      expect(list.map((x) => x.canonicalTaskType)).toEqual(["CALLBACK", "FOLLOW_UP", "FOLLOW_UP", "FOLLOW_UP", "FOLLOW_UP"]);
      expect(list.find((x) => x.key === "appointment_risk")).toMatchObject({ defaultPriority: "high", requiresNote: true, defaultOwner: "JOURNEY_OWNER" });
      expect(list.every((x) => x.isActive && x.departmentId === null)).toBe(true);
    });

    it("an Admin can add, rename and reorder; the key never changes; duplicate names are refused", async () => {
      const created = await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Pre-op counselling", canonicalTaskType: "FOLLOW_UP", defaultPriority: "high", requiresNote: true });
      expect(created.statusCode).toBe(201);
      const c = created.json() as FollowUpTypeVm;
      expect(c).toMatchObject({ label: "Pre-op counselling", key: "custom_pre_op_counselling", defaultPriority: "high", requiresNote: true, isActive: true });
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "pre-OP counselling" })).statusCode).toBe(409);

      const renamed = (await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${c.id}`, { label: "Pre-surgery counselling" })).json() as FollowUpTypeVm;
      expect(renamed).toMatchObject({ label: "Pre-surgery counselling", key: c.key });

      const all = await types(t);
      const reordered = [all.at(-1)!, ...all.slice(0, -1)].map((x) => x.id);
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types/reorder", { orderedIds: reordered })).statusCode).toBe(200);
      expect((await types(t)).map((x) => x.id)).toEqual(reordered);
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types/reorder", { orderedIds: [reordered[0], reordered[0]] })).statusCode).toBe(400);
    });

    it("a type can be limited to a department; one from another hospital's department is refused", async () => {
      const ophth = (await call(t, "HOSPITAL_ADMIN", "GET", "/departments")).json() as { id: string }[];
      const scoped = await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Eye drops check", departmentId: ophth[0]!.id });
      expect(scoped.statusCode).toBe(201);
      const foreign = (await call(other, "HOSPITAL_ADMIN", "GET", "/departments")).json() as { id: string }[];
      expect((await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Sneaky", departmentId: foreign[0]!.id })).statusCode).toBe(404);
      const { journeyId } = await newJourney(t); // a Cataract journey belongs to the Ophthalmology department
      expect((await types(t, "FRONT_DESK", `?journeyId=${journeyId}`)).map((x) => x.label)).toContain("Eye drops check");
    });

    it("Staff and Doctor cannot edit configuration; every task role can read the active types", async () => {
      const any = (await types(t))[0]!;
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
        expect((await call(t, role, "POST", "/followup-types", { label: "Nope" })).statusCode, role).toBe(403);
        expect((await call(t, role, "PATCH", `/followup-types/${any.id}`, { label: "Nope" })).statusCode, role).toBe(403);
        expect((await call(t, role, "POST", "/followup-types/reorder", { orderedIds: [any.id] })).statusCode, role).toBe(403);
      }
      expect((await call(t, "FRONT_DESK", "GET", "/followup-types")).statusCode).toBe(200);
      expect((await call(t, "SUPER_ADMIN", "POST", "/followup-types", { label: "Super admin made this" })).statusCode).toBe(201);
    });

    it("another hospital's types are invisible and untouchable", async () => {
      const mine = (await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Only ours" })).json() as FollowUpTypeVm;
      expect((await types(other)).map((x) => x.id)).not.toContain(mine.id);
      expect((await call(other, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${mine.id}`, { label: "Hijack" })).statusCode).toBe(404);
      expect((await db.select().from(followUpTypes).where(eq(followUpTypes.id, mine.id)))[0]!.label).toBe("Only ours");
    });

    it("archiving stops new use but old tasks keep the label; the last active type cannot be archived; Staff do not see archived", async () => {
      const made = (await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Short-lived" })).json() as FollowUpTypeVm;
      const { journeyId } = await newJourney(t);
      const first = await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: made.id, dueAt: inHours(30) });
      expect(first.statusCode).toBe(201);

      expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${made.id}`, { isActive: false })).statusCode).toBe(200);
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: made.id, dueAt: inHours(31) })).statusCode).toBe(422);
      expect((await types(t, "FRONT_DESK")).map((x) => x.id)).not.toContain(made.id);
      expect((await types(t, "FRONT_DESK", "?includeInactive=true")).map((x) => x.id)).not.toContain(made.id); // staff cannot ask for archived
      expect((await types(t, "HOSPITAL_ADMIN", "?includeInactive=true")).find((x) => x.id === made.id)?.isActive).toBe(false);

      // the historical task still renders its (archived) type label
      const tasksNow = (await call(t, "HOSPITAL_ADMIN", "GET", `/tasks?patientId=${(await detail(t, "HOSPITAL_ADMIN", journeyId)).patient.id}`)).json() as TaskRow[];
      expect(tasksNow.find((x) => x.id === (first.json() as TaskRow).id)?.typeLabel).toBe("Short-lived");

      // restore, then try to archive everything: the last one stays
      expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${made.id}`, { isActive: true })).statusCode).toBe(200);
      const active = await types(t);
      for (const ty of active.slice(0, -1)) await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${ty.id}`, { isActive: false });
      const lastOne = active.at(-1)!;
      const refused = await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${lastOne.id}`, { isActive: false });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("last_active_type");
      for (const ty of active.slice(0, -1)) await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${ty.id}`, { isActive: true });
    });
  });

  describe("Add Follow-up", () => {
    it("creates one Task through the Task engine, labelled with the type, due in the hospital's clock, with one Timeline line", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.PATIENT_COORDINATOR });
      const dueAt = "2026-12-15T05:30:00.000Z"; // 11:00 in the hospital
      const res = await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "appointment_followup"), dueAt: new Date(Math.max(Date.parse(dueAt), Date.now() + 86_400_000)).toISOString() });
      expect(res.statusCode).toBe(201);
      const task = res.json() as TaskRow;
      expect(task).toMatchObject({ type: "FOLLOW_UP", followUpTypeKey: "appointment_followup", typeLabel: "Appointment Follow-up", status: "pending", journeyId, patientId, priority: "normal" });
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(1);
      const lines = (await timelineOf(t, patientId)).filter((e) => e.eventType === "task_created");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ title: "Follow-up scheduled · Appointment Follow-up" });
      expect(lines[0]!.description).toMatch(/^Due .*· Assigned to /);
    });

    it("the due time and the Timeline wording use the hospital's timezone, whatever zone the server runs in", async () => {
      const { journeyId, patientId } = await newJourney(t);
      const due = new Date(Date.parse("2027-03-10T00:00:00Z")); // 2027-03-10 05:30Z = 11:00 IST
      due.setUTCHours(5, 30, 0, 0);
      const res = await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: due.toISOString() });
      expect(res.statusCode).toBe(201);
      expect((res.json() as TaskRow).dueAt).toBe("2027-03-10T05:30:00.000Z");
      const line = (await timelineOf(t, patientId)).find((e) => e.eventType === "task_created")!;
      expect(line.description).toContain("11:00 am");
      expect(line.description).toContain("10 Mar");
    });

    it("refuses a past time, a malformed time, an unknown/inactive type and an over-long note — saving nothing", async () => {
      const { journeyId } = await newJourney(t);
      const type = await typeId(t, "general_followup");
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: type, dueAt: inHours(-2) })).json().error).toBe("due_in_past");
      expect([400, 422]).toContain((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: type, dueAt: "not-a-date" })).statusCode);
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: "00000000-0000-0000-0000-000000000000", dueAt: inHours(5) })).statusCode).toBe(422);
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: type, dueAt: inHours(5), note: "x".repeat(501) })).statusCode).toBe(400);
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: type, dueAt: inHours(5), surprise: true })).statusCode).toBe(400);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(0);
    });

    it("the owner defaults per the type: Journey owner (else the person adding), the person adding, or nobody; an explicit owner or null wins", async () => {
      const owned = await newJourney(t, { ownerId: t.userIds.PATIENT_COORDINATOR });
      const unowned = await newJourney(t);
      const general = await typeId(t, "general_followup");
      const byOwner = (await addFollowUp(t, "FRONT_DESK", owned.journeyId, { followUpTypeId: general, dueAt: inHours(9) })).json() as TaskRow;
      expect(byOwner.assignedTo).toBe(t.userIds.PATIENT_COORDINATOR);
      const noOwner = (await addFollowUp(t, "FRONT_DESK", unowned.journeyId, { followUpTypeId: general, dueAt: inHours(9) })).json() as TaskRow;
      expect(noOwner.assignedTo).toBe(t.userIds.FRONT_DESK);

      const actorType = (await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Mine to do", defaultOwner: "ACTOR" })).json() as FollowUpTypeVm;
      expect(((await addFollowUp(t, "FRONT_DESK", owned.journeyId, { followUpTypeId: actorType.id, dueAt: inHours(9) })).json() as TaskRow).assignedTo).toBe(t.userIds.FRONT_DESK);
      const nobody = (await call(t, "HOSPITAL_ADMIN", "POST", "/followup-types", { label: "Pool task", defaultOwner: "UNASSIGNED" })).json() as FollowUpTypeVm;
      expect(((await addFollowUp(t, "FRONT_DESK", owned.journeyId, { followUpTypeId: nobody.id, dueAt: inHours(9) })).json() as TaskRow).assignedTo).toBeNull();

      expect(((await addFollowUp(t, "FRONT_DESK", owned.journeyId, { followUpTypeId: general, dueAt: inHours(9), assignedTo: t.userIds.HOSPITAL_ADMIN })).json() as TaskRow).assignedTo).toBe(t.userIds.HOSPITAL_ADMIN);
      expect(((await addFollowUp(t, "FRONT_DESK", owned.journeyId, { followUpTypeId: general, dueAt: inHours(9), assignedTo: null })).json() as TaskRow).assignedTo).toBeNull();
    });

    it("an owner from another hospital (or a made-up one) is refused and nothing is saved", async () => {
      const { journeyId } = await newJourney(t);
      const res = await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(9), assignedTo: other.userIds.FRONT_DESK });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("assignee_invalid");
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).toHaveLength(0);
    });

    it("Appointment Risk: needs a reason, defaults to high priority, and drives its own My Work bucket and count", async () => {
      const { journeyId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      const risk = await typeId(t, "appointment_risk");
      const noNote = await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: risk, dueAt: inHours(8) });
      expect(noNote.statusCode).toBe(422);
      expect(noNote.json().error).toBe("note_required");
      const ok = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: risk, dueAt: inHours(8), note: "Doctor on leave that day — reschedule" })).json() as TaskRow;
      expect(ok).toMatchObject({ typeLabel: "Appointment Risk", priority: "high", followUpTypeKey: "appointment_risk" });
      // any reason is allowed — it is just the note
      const second = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      expect((await addFollowUp(t, "FRONT_DESK", second.journeyId, { followUpTypeId: risk, dueAt: inHours(9), note: "Patient asked to move the time" })).statusCode).toBe(201);

      const bucket = (await call(t, "FRONT_DESK", "GET", "/tasks?view=appointment_risk&assignedTo=" + t.userIds.FRONT_DESK)).json() as TaskRow[];
      expect(bucket.length).toBeGreaterThanOrEqual(2);
      expect(bucket.every((x) => x.followUpTypeKey === "appointment_risk" && x.status !== "completed")).toBe(true);
      const counts = (await call(t, "FRONT_DESK", "GET", "/tasks/counts")).json() as TaskCounts;
      expect(counts.appointmentRisk).toBe(bucket.length);
      // other follow-ups are not in the bucket
      const general = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(9), assignedTo: t.userIds.FRONT_DESK })).json() as TaskRow;
      expect(((await call(t, "FRONT_DESK", "GET", "/tasks?view=appointment_risk")).json() as TaskRow[]).map((x) => x.id)).not.toContain(general.id);

      // completing removes it from the active bucket
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${ok.id}/complete`)).statusCode).toBe(200);
      expect(((await call(t, "FRONT_DESK", "GET", "/tasks?view=appointment_risk")).json() as TaskRow[]).map((x) => x.id)).not.toContain(ok.id);
      expect(((await call(t, "FRONT_DESK", "GET", "/tasks/counts")).json() as TaskCounts).appointmentRisk).toBe(bucket.length - 1);
    });

    it("Surgery Follow-up is just another type on the same engine (no surgery scheduling involved)", async () => {
      const { journeyId } = await newJourney(t);
      const res = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "surgery_followup"), dueAt: inHours(48), note: "Confirm surgery decision" })).json() as TaskRow;
      expect(res).toMatchObject({ typeLabel: "Surgery Follow-up", type: "FOLLOW_UP", status: "pending" });
    });

    it("who may add: Admin, Super Admin and Staff; Doctor no; signed out no; another hospital's journey is a 404", async () => {
      const { journeyId } = await newJourney(t);
      const body = { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(12) };
      for (const role of ["HOSPITAL_ADMIN", "SUPER_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"] as Role[]) expect((await addFollowUp(t, role, journeyId, body)).statusCode, role).toBe(201);
      const doctor = await addFollowUp(t, "DOCTOR", journeyId, body);
      expect(doctor.statusCode).toBe(403);
      expect(doctor.json().requiredPermission).toBe("MANAGE_TASKS");
      expect((await app.inject({ method: "POST", url: `/journeys/${journeyId}/follow-ups`, payload: body })).statusCode).toBe(401);
      expect((await addFollowUp(other, "FRONT_DESK", journeyId, body)).statusCode).toBe(404);
      // a type id from the other hospital cannot be used here either
      const foreignType = (await types(other))[0]!.id;
      expect((await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: foreignType, dueAt: inHours(12) })).statusCode).toBe(422);
    });
  });

  describe("callbacks resolve to the Callback type", () => {
    it("a callback from a logged call reads 'Callback' (not a generic follow-up), follows a rename, and has one Timeline line", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      const log = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, outcomeKey: "needs_callback", callback: { dueAt: inHours(26) } });
      expect(log.statusCode).toBe(201);
      const row = ((await call(t, "FRONT_DESK", "GET", `/tasks?patientId=${patientId}`)).json() as TaskRow[]).find((x) => x.id === log.json().callbackTaskId)!;
      expect(row).toMatchObject({ type: "CALLBACK", typeLabel: "Callback" });
      const lines = (await timelineOf(t, patientId)).filter((e) => e.eventType === "task_created");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.title).toBe("Follow-up scheduled · Callback");

      const cb = (await types(t)).find((x) => x.key === "callback")!;
      await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${cb.id}`, { label: "Call back" });
      expect(((await call(t, "FRONT_DESK", "GET", `/tasks?patientId=${patientId}`)).json() as TaskRow[]).find((x) => x.id === row.id)?.typeLabel).toBe("Call back");
      await call(t, "HOSPITAL_ADMIN", "PATCH", `/followup-types/${cb.id}`, { label: "Callback" });
    });

    it("the missed-IVR-call Task also reads 'Callback'", async () => {
      const { patientId } = await newJourney(t);
      await db.insert(tasks).values({ tenantId: t.tenantId, patientId, assignedTo: t.userIds.FRONT_DESK, type: "CALLBACK", reason: "missed_follow_up", status: "pending", dueAt: new Date(Date.now() + 7_200_000) });
      const row = ((await call(t, "FRONT_DESK", "GET", `/tasks?patientId=${patientId}`)).json() as TaskRow[]).find((x) => x.reason === "missed_follow_up")!;
      expect(row.typeLabel).toBe("Callback");
    });
  });

  describe("complete, reschedule, reassign", () => {
    it("complete updates the task, writes exactly one meaningful line, and a second completion is a 409 with no second line", async () => {
      const { journeyId, patientId } = await newJourney(t);
      const task = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "appointment_followup"), dueAt: inHours(10) })).json() as TaskRow;
      const done = await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/complete`);
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ status: "completed" });
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/complete`)).statusCode).toBe(409);
      const lines = (await timelineOf(t, patientId)).filter((e) => e.eventType === "task_completed");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.title).toBe("Follow-up completed · Appointment Follow-up");
    });

    it("reschedule moves the due time (hospital clock), refuses the past, optionally records why, and refuses a closed task", async () => {
      const { journeyId, patientId } = await newJourney(t);
      const task = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(10), note: "First call" })).json() as TaskRow;
      const later = inHours(60);
      const ok = await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reschedule`, { dueAt: later, note: "Patient asked for Monday" });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as TaskRow).dueAt).toBe(later);
      expect((ok.json() as TaskRow).notes).toBe("First call — Patient asked for Monday");
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reschedule`, { dueAt: inHours(-3) })).json().error).toBe("due_in_past");
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reschedule`, { dueAt: "garbage" })).statusCode).toBe(400);
      const line = (await timelineOf(t, patientId)).find((e) => e.eventType === "task_rescheduled")!;
      expect(line.title).toBe("Follow-up rescheduled · General Follow-up");
      expect(line.description).toContain("Patient asked for Monday");
      await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/complete`);
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reschedule`, { dueAt: inHours(70) })).statusCode).toBe(409);
    });

    it("reassign moves only the task to a person in this hospital; the Journey's owner is untouched; a foreign or unknown user is refused", async () => {
      const { journeyId } = await newJourney(t, { ownerId: t.userIds.PATIENT_COORDINATOR });
      const task = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(10) })).json() as TaskRow;
      expect(task.assignedTo).toBe(t.userIds.PATIENT_COORDINATOR);
      const res = await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reassign`, { assignedTo: t.userIds.HOSPITAL_ADMIN });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ assignedTo: t.userIds.HOSPITAL_ADMIN });
      expect((await db.select().from(journeys).where(eq(journeys.id, journeyId)))[0]!.ownerUserId).toBe(t.userIds.PATIENT_COORDINATOR);
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reassign`, { assignedTo: other.userIds.FRONT_DESK })).statusCode).toBe(422);
      expect((await call(t, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reassign`, { assignedTo: "not-a-uuid" })).statusCode).toBe(422);
      expect(((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0])!.assignedTo).toBe(t.userIds.HOSPITAL_ADMIN);
      // the journey now honestly shows two different people
      const d = await detail(t, "FRONT_DESK", journeyId);
      expect(d.journey.owner?.id).toBe(t.userIds.PATIENT_COORDINATOR);
      expect(d.journey.nextTask?.assignedTo).toBe(t.userIds.HOSPITAL_ADMIN);
    });

    it("tasks of another hospital are a 404 for every action", async () => {
      const { journeyId } = await newJourney(t);
      const task = (await addFollowUp(t, "FRONT_DESK", journeyId, { followUpTypeId: await typeId(t, "general_followup"), dueAt: inHours(10) })).json() as TaskRow;
      expect((await call(other, "FRONT_DESK", "PATCH", `/tasks/${task.id}/complete`)).statusCode).toBe(404);
      expect((await call(other, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reschedule`, { dueAt: inHours(30) })).statusCode).toBe(404);
      expect((await call(other, "FRONT_DESK", "PATCH", `/tasks/${task.id}/reassign`, { assignedTo: other.userIds.FRONT_DESK })).statusCode).toBe(404);
      expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: "pending" });
    });

    it("the generic Add Task keeps allowing an already-overdue time, but only for things in this hospital", async () => {
      const { journeyId, patientId } = await newJourney(t);
      expect((await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "CALLBACK", dueAt: inHours(-5), assignedTo: t.userIds.FRONT_DESK })).statusCode).toBe(200);
      expect((await call(other, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "CALLBACK", dueAt: inHours(5) })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, type: "CALLBACK", dueAt: inHours(5), assignedTo: other.userIds.FRONT_DESK })).statusCode).toBe(422);
      expect((await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, type: "CALLBACK", dueAt: "nope" })).statusCode).toBe(400);
    });
  });

  describe("Next Action on the Journey", () => {
    it("is derived from the open tasks: overdue first, then today, then upcoming — and moves on as each is completed", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      const make = async (due: string) => (await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "FOLLOW_UP", dueAt: due, assignedTo: t.userIds.FRONT_DESK })).json() as TaskRow;
      expect((await detail(t, "FRONT_DESK", journeyId)).journey).toMatchObject({ nextTask: null, nextTaskBucket: null, nextAction: null });

      const upcoming = await make(inHours(24 * 5));
      expect((await detail(t, "FRONT_DESK", journeyId)).journey).toMatchObject({ nextTaskBucket: "upcoming", nextTask: { id: upcoming.id } });

      const endOfHospitalDay = new Date(Date.parse(`${new Date().toLocaleDateString("en-CA", { timeZone: TZ })}T00:00:00+05:30`) + 86_400_000);
      const today = await make(new Date(Date.now() + (endOfHospitalDay.getTime() - Date.now()) / 2).toISOString());
      const overdue = await make(inHours(-30));
      let d = await detail(t, "FRONT_DESK", journeyId);
      expect(d.journey.nextTask?.id).toBe(overdue.id);
      expect(d.journey.nextTaskBucket).toBe("overdue");
      expect(d.journey.nextAction?.label).toBe("General Follow-up");

      await call(t, "FRONT_DESK", "PATCH", `/tasks/${overdue.id}/complete`);
      d = await detail(t, "FRONT_DESK", journeyId);
      expect([d.journey.nextTask?.id, d.journey.nextTaskBucket]).toEqual([today.id, "today"]);

      await call(t, "FRONT_DESK", "PATCH", `/tasks/${today.id}/complete`);
      d = await detail(t, "FRONT_DESK", journeyId);
      expect([d.journey.nextTask?.id, d.journey.nextTaskBucket]).toEqual([upcoming.id, "upcoming"]);

      await call(t, "FRONT_DESK", "PATCH", `/tasks/${upcoming.id}/complete`);
      expect((await detail(t, "FRONT_DESK", journeyId)).journey).toMatchObject({ nextTask: null, nextAction: null });
    });

    it("rescheduling an overdue task into the future re-derives the Next Action; a high-priority task in the same bucket comes first", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      const make = async (due: string, priority: "normal" | "high") => (await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "FOLLOW_UP", dueAt: due, priority, assignedTo: t.userIds.FRONT_DESK })).json() as TaskRow;
      const a = await make(inHours(-48), "normal");
      const b = await make(inHours(-6), "high");
      expect((await detail(t, "FRONT_DESK", journeyId)).journey.nextTask?.id).toBe(b.id);
      await call(t, "FRONT_DESK", "PATCH", `/tasks/${b.id}/reschedule`, { dueAt: inHours(72) });
      expect((await detail(t, "FRONT_DESK", journeyId)).journey.nextTask?.id).toBe(a.id);
    });

    it("is never stored: the Journey table has no next-action column", async () => {
      const cols = (await db.execute(`select column_name from information_schema.columns where table_name = 'journeys'` as never)) as unknown as { column_name: string }[];
      expect([...cols].map((c) => c.column_name).filter((c) => /next/i.test(c))).toEqual([]);
    });

    it("a Doctor sees no task note or owner in the Next Action — only the label and time of the nearest open task", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "FOLLOW_UP", dueAt: inHours(20), notes: "Private staff note", assignedTo: t.userIds.FRONT_DESK });
      const d = await detail(t, "DOCTOR", journeyId);
      expect(d.journey.nextTask).toBeNull();
      expect(d.journey.nextAction).toMatchObject({ label: "General Follow-up" });
      expect(JSON.stringify(d)).not.toContain("Private staff note");
    });
  });

  describe("Book Appointment", () => {
    it("links the Journey and Patient, writes one Timeline line in the hospital clock, and shows on the Journey", async () => {
      const { journeyId, patientId } = await newJourney(t);
      const scheduledAt = "2027-02-10T05:30:00.000Z";
      const res = await call(t, "FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: t.branchId, doctorId: t.userIds.DOCTOR, scheduledAt, reason: "Cataract consultation" });
      expect(res.statusCode).toBe(201);
      const appt = res.json() as AppointmentRow;
      // The doctor is a scheduling resource; the Doctor user's own profile is linked to their login.
      const [resource] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!));
      expect(appt).toMatchObject({ patientId, journeyId, doctorId: resource!.id, status: "scheduled", reason: "Cataract consultation" });
      const lines = (await timelineOf(t, patientId)).filter((e) => e.eventType === "appointment_created");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.title).toContain("Appointment booked");
      expect(lines[0]!.title).toContain("11:00 am");
      expect((await detail(t, "FRONT_DESK", journeyId)).appointments.map((a) => a.id)).toContain(appt.id);
      expect(((await call(t, "FRONT_DESK", "GET", `/appointments?journeyId=${journeyId}`)).json() as AppointmentRow[]).map((a) => a.id)).toContain(appt.id);
    });

    it("refuses anything not in this hospital: another hospital's journey, a journey of a different patient, a foreign branch, a non-doctor", async () => {
      const a = await newJourney(t);
      const b = await newJourney(t);
      const foreign = await newJourney(other);
      const base = { patientId: a.patientId, journeyId: a.journeyId, branchId: t.branchId, doctorId: t.userIds.DOCTOR, scheduledAt: inHours(48) };
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, journeyId: foreign.journeyId })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, journeyId: b.journeyId })).statusCode).toBe(404); // not that patient's journey
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, branchId: other.branchId })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, doctorId: t.userIds.PATIENT_COORDINATOR })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, doctorId: other.userIds.DOCTOR })).statusCode).toBe(404);
      expect((await call(t, "FRONT_DESK", "POST", "/appointments", { ...base, scheduledAt: "garbage" })).statusCode).toBe(400);
      expect((await call(t, "DOCTOR", "POST", "/appointments", base)).statusCode).toBe(403);
      expect(((await call(t, "FRONT_DESK", "GET", `/appointments?journeyId=${a.journeyId}`)).json() as AppointmentRow[])).toHaveLength(0);
    });
  });

  describe("an outcome that needs a follow-up never leaves a Journey without its Task", () => {
    it("every path that records such an outcome either creates exactly one Task or saves nothing", async () => {
      const { journeyId, patientId } = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      const before = async () => ({ tasks: (await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).length, journey: (await db.select().from(journeys).where(eq(journeys.id, journeyId)))[0]!.lastOutcomeId });

      // Log outcome
      expect((await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "needs_callback" })).statusCode).toBe(400); // follow_up_required
      expect(await before()).toEqual({ tasks: 0, journey: null });
      expect((await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "needs_callback", followUpAt: inHours(24) })).statusCode).toBe(201);
      expect((await before()).tasks).toBe(1);

      // Log call
      const second = await newJourney(t, { ownerId: t.userIds.FRONT_DESK });
      expect((await call(t, "FRONT_DESK", "POST", `/journeys/${second.journeyId}/calls`, { direction: "inbound", connected: true, outcomeKey: "needs_callback" })).statusCode).toBe(422);
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, second.journeyId))).toHaveLength(0);

      // Add Lead with a follow-up for an unknown owner: no lead at all
      const bad = await call(t, "FRONT_DESK", "POST", "/leads", { phone: phone(), specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {}, followUp: { type: "CALLBACK", dueAt: inHours(24), assignedTo: other.userIds.FRONT_DESK } });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().fields).toContain("followUp");
      expect(patientId).toBeTruthy();
    });

    it("Add Lead with a valid first follow-up creates the Task and one Timeline line", async () => {
      const lead = await newJourney(t, { followUp: { type: "CALLBACK", dueAt: inHours(24), assignedTo: t.userIds.FRONT_DESK } });
      const row = (await db.select().from(tasks).where(eq(tasks.journeyId, lead.journeyId)))[0]!;
      expect(row).toMatchObject({ type: "CALLBACK", assignedTo: t.userIds.FRONT_DESK });
      expect((await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, lead.journeyId), eq(timelineEvents.eventType, "task_created"))))).toHaveLength(1);
    });
  });
});

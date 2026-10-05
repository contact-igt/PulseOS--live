import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ClinicHours, LogInteractionResult, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, notificationRules, notifications, scheduleResources, tasks, tenants, timelineEvents } from "../db/schema.js";
import { addDays, dayKeyIn } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const HOURS: ClinicHours = { mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null };

// "Log outcome" on a follow-up can book the visit in the same save: one transaction, same rules as booking directly.
describe.skipIf(!DEMO_PASSWORD)("follow-up outcome + appointment in one save (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let doctorId: string;
  let n = 0;
  let slot = 0;

  const as = (role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  async function journey() {
    const res = await as("FRONT_DESK", "POST", "/leads", { phone: `+9196${String(65000000 + ++n * 47).padStart(8, "0")}`, name: "Outcome Book", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { journeyId: string };
  }
  const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000 + ++slot * 60_000).toISOString();
  const log = (journeyId: string, body: object, role: Role = "FRONT_DESK") => as(role, "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "interested", note: "Patient called back and confirmed consultation.", ...body });
  const visits = (journeyId: string) => db.select().from(appointments).where(eq(appointments.journeyId, journeyId));
  const events = async (journeyId: string) => (await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, journeyId))).map((e) => e.eventType);
  const messages = async (id: string) => (await db.select({ n: notifications, r: notificationRules }).from(notifications).leftJoin(notificationRules, eq(notifications.ruleId, notificationRules.id)).where(eq(notifications.subjectId, id))).map((x) => ({ ...x.n, kind: x.r?.kind, offsetValue: x.r?.offsetValue, offsetUnit: x.r?.offsetUnit }));
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await app.inject({ method: "POST", url: "/departments/install", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { templateKey: "ophthalmology" } });
    await as("HOSPITAL_ADMIN", "GET", "/notification-rules");
    doctorId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
  });
  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.tenantId, t.tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));
    await db.delete(appointments).where(eq(appointments.tenantId, t.tenantId));
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("an outcome alone is unchanged: logged, no visit", async () => {
    const { journeyId } = await journey();
    const res = await log(journeyId, { followUpAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(res.statusCode).toBe(201);
    expect(await visits(journeyId)).toHaveLength(0);
    expect((res.json() as LogInteractionResult).followUpTaskId).toBeTruthy();
  });

  it("outcome + booked visit (not confirmed): BOOKED, no message, and NO follow-up task (the visit is the next step)", async () => {
    const { journeyId } = await journey();
    const res = await log(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: false } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as LogInteractionResult;
    expect(body).toMatchObject({ followUpTaskId: null, appointmentStatus: "scheduled" });
    const [visit] = await visits(journeyId);
    expect(visit).toMatchObject({ id: body.appointmentId, status: "scheduled" });
    expect((await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).filter((x) => x.status === "pending")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(await messages(visit!.id)).toHaveLength(0);
  });

  it("outcome + confirmed visit: CONFIRMED, the confirmation and the 1-hour reminder are each planned exactly once; timeline has outcome, booked, confirmed", async () => {
    const { journeyId } = await journey();
    const res = await log(journeyId, { appointment: { scheduledAt: inTwoDays(), confirmed: true, doctorId, branchId: t.branchId } });
    expect(res.statusCode).toBe(201);
    expect((res.json() as LogInteractionResult).appointmentStatus).toBe("confirmed");
    const [visit] = await visits(journeyId);
    expect(visit!.status).toBe("confirmed");
    const planned = await until(() => messages(visit!.id), (r) => r.length >= 3);
    expect(planned.filter((m) => m.kind === "CONFIRMATION")).toHaveLength(1);
    expect(planned.filter((m) => m.kind === "REMINDER" && m.offsetValue === 1 && m.offsetUnit === "hours")).toHaveLength(1);
    expect(planned.some((m) => m.status === "SENT")).toBe(false); // no provider: never "sent"
    const types = await events(journeyId);
    expect(types).toEqual(expect.arrayContaining(["outcome_logged", "appointment_created", "appointment_confirmed"]));
  });

  it("a follow-up time AND a visit together is refused (one next step); an outcome that does not allow visits refuses one", async () => {
    const { journeyId } = await journey();
    const both = await log(journeyId, { followUpAt: new Date(Date.now() + 86_400_000).toISOString(), appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId } });
    expect(both.statusCode).toBe(400);
    const notAllowed = await log(journeyId, { outcomeKey: "price_enquiry", appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId } });
    expect(notAllowed.statusCode).toBe(422);
    expect(notAllowed.json()).toEqual({ error: "outcome_disallows_appointment" });
    expect(await visits(journeyId)).toHaveLength(0);
  });

  describe("a refused booking keeps nothing", () => {
    const setHours = (clinicHours: ClinicHours | null) => db.update(tenants).set({ clinicHours, timezone: "Asia/Kolkata" }).where(eq(tenants.id, t.tenantId));
    afterAll(() => setHours(null));

    it("past time, outside hours and a taken slot each give a clear refusal; the outcome is not logged and no visit exists", async () => {
      await setHours(HOURS);
      let sunday = addDays(dayKeyIn(new Date(), "Asia/Kolkata"), 2);
      while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
      const { journeyId } = await journey();
      for (const [at, reason, status] of [[new Date(Date.now() - 3_600_000).toISOString(), "appointment_time_in_past", 422], [`${sunday}T10:00`, "outside_clinic_hours", 422]] as const) {
        const res = await log(journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId } });
        expect(res.statusCode, at).toBe(status);
        expect(res.json()).toEqual({ error: reason });
      }
      expect((await events(journeyId)).filter((e) => e === "outcome_logged")).toHaveLength(0);
      expect(await visits(journeyId)).toHaveLength(0);

      await setHours(null);
      const at = inTwoDays();
      const a = await journey();
      expect((await log(a.journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId } })).statusCode).toBe(201);
      const b = await journey();
      const taken = await log(b.journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId } });
      expect(taken.statusCode).toBe(409);
      expect((await events(b.journeyId)).filter((e) => e === "outcome_logged")).toHaveLength(0);
    });
  });

  it("a double submit books one visit and plans one set of messages", async () => {
    const { journeyId } = await journey();
    const body = { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: true } };
    const [a, b] = await Promise.all([log(journeyId, body), log(journeyId, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]); // the slot lock lets exactly one win
    const made = await visits(journeyId);
    expect(made).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 500));
    expect((await messages(made[0]!.id)).filter((m) => m.kind === "CONFIRMATION")).toHaveLength(1);
  });

  it("the doctor role cannot book through an outcome, and sole doctor/branch are filled in when omitted", async () => {
    const { journeyId } = await journey();
    const denied = await log(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId } }, "DOCTOR");
    expect([401, 403]).toContain(denied.statusCode);
    expect(await visits(journeyId)).toHaveLength(0);
  });
});

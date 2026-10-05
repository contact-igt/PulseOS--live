import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ClinicHours, LogCallResult, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, calls, notificationRules, notifications, scheduleResources, tasks, tenants, timelineEvents } from "../db/schema.js";
import { addDays, dayKeyIn } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const HOURS: ClinicHours = { mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null };

// Staff on a phone call with a patient: log the call, and in the same save either schedule a callback or book the visit
// (BOOKED, or CONFIRMED when the patient agreed on the call). One save, one transaction, nothing doubled on a retry.
describe.skipIf(!DEMO_PASSWORD)("log a call and book the visit from it (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let doctorId: string;
  let n = 0;
  let slot = 0;

  const as = (role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  async function journey() {
    const res = await as("FRONT_DESK", "POST", "/leads", { phone: `+9196${String(63000000 + ++n * 41).padStart(8, "0")}`, name: "Asha Rao", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  /** A future instant, two days out, distinct minute per call (a doctor has one patient per minute). */
  const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000 + ++slot * 60_000).toISOString();
  const logCall = (journeyId: string, body: object, role: Role = "FRONT_DESK") => as(role, "POST", `/journeys/${journeyId}/calls`, { direction: "inbound", connected: true, staffFeedback: "Patient wants a cataract consultation.", ...body });
  const visits = (journeyId: string) => db.select().from(appointments).where(eq(appointments.journeyId, journeyId));
  const timeline = async (journeyId: string) => (await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, journeyId))).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  /** The planned messages for a visit, each with the rule that planned it (CONFIRMATION / REMINDER and its offset). */
  const messages = async (appointmentId: string) => (await db.select({ n: notifications, rule: notificationRules }).from(notifications).leftJoin(notificationRules, eq(notifications.ruleId, notificationRules.id)).where(eq(notifications.subjectId, appointmentId))).map((r) => ({ ...r.n, kind: r.rule?.kind, offsetValue: r.rule?.offsetValue, offsetUnit: r.rule?.offsetUnit }));
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
    // The rules/templates are installed on first read.
    await as("HOSPITAL_ADMIN", "GET", "/notification-rules");
    doctorId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
  });
  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.tenantId, t.tenantId));
    await db.update(calls).set({ callbackTaskId: null }).where(eq(calls.tenantId, t.tenantId));
    await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));
    await db.delete(appointments).where(eq(appointments.tenantId, t.tenantId));
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("a call with a callback creates the callback task and no appointment", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { callback: { dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), note: "Call back after lunch" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as LogCallResult;
    expect(body.callbackTaskId).toBeTruthy();
    expect(body.appointmentId).toBeNull();
    expect(await visits(journeyId)).toHaveLength(0);
    expect((await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).filter((x) => x.type === "CALLBACK" || x.type === "FOLLOW_UP")).not.toHaveLength(0);
  });

  it("booking from the call (not confirmed) makes a BOOKED visit, plans no message, and creates no callback task", async () => {
    const { journeyId } = await journey();
    const taskCountBefore = (await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).length;
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: false } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as LogCallResult;
    expect(body).toMatchObject({ callbackTaskId: null, appointmentStatus: "scheduled", duplicate: false });
    const [visit] = await visits(journeyId);
    expect(visit).toMatchObject({ id: body.appointmentId, status: "scheduled" });
    expect((await db.select().from(tasks).where(eq(tasks.journeyId, journeyId))).length).toBe(taskCountBefore); // a booked visit is the follow-up: no extra work for My Work
    await new Promise((r) => setTimeout(r, 400));
    expect(await messages(visit!.id)).toHaveLength(0); // BOOKED sends nothing
  });

  it("booking with 'confirmed with patient' makes a CONFIRMED visit; the confirmation and the 1-hour reminder are each planned exactly once", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: true } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as LogCallResult;
    expect(body.appointmentStatus).toBe("confirmed");
    const [visit] = await visits(journeyId);
    expect(visit).toMatchObject({ id: body.appointmentId, status: "confirmed" });
    const planned = await until(() => messages(visit!.id), (r) => r.length >= 3);
    const kinds = planned.map((m) => `${m.kind}`).sort();
    expect(kinds.filter((k) => k === "CONFIRMATION")).toHaveLength(1);
    expect(planned.filter((m) => m.kind === "REMINDER" && m.offsetValue === 1 && m.offsetUnit === "hours")).toHaveLength(1);
  });

  it("with no WhatsApp provider the visit still succeeds and the message is Blocked / Not configured — never 'Sent'", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: true } });
    expect(res.statusCode).toBe(201);
    const [visit] = await visits(journeyId);
    const planned = await until(() => messages(visit!.id), (r) => r.length >= 1);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.some((m) => m.status === "SENT")).toBe(false);
  });

  it("the timeline keeps meaningful, separate, chronological events: call, appointment booked, appointment confirmed", async () => {
    const { journeyId } = await journey();
    await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: true } });
    const events = (await timeline(journeyId)).map((e) => e.eventType);
    expect(events).toContain("call_logged");
    expect(events).toContain("appointment_created");
    expect(events).toContain("appointment_confirmed");
    expect(events.indexOf("call_logged")).toBeLessThan(events.indexOf("appointment_confirmed"));
  });

  it("a double submit (same key) books once: one call, one visit, one set of messages", async () => {
    const { journeyId } = await journey();
    const body = { idempotencyKey: `dbl-${randomUUID()}`, appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId, confirmed: true } };
    const [a, b] = await Promise.all([logCall(journeyId, body), logCall(journeyId, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    const again = await logCall(journeyId, body);
    expect(again.statusCode).toBe(200);
    expect(await db.select().from(calls).where(eq(calls.journeyId, journeyId))).toHaveLength(1);
    const made = await visits(journeyId);
    expect(made).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 500));
    const planned = await messages(made[0]!.id);
    expect(planned.filter((m) => m.kind === "CONFIRMATION")).toHaveLength(1);
  });

  describe("a refused booking keeps nothing (the form keeps what staff typed)", () => {
    const setHours = (clinicHours: ClinicHours | null) => db.update(tenants).set({ clinicHours, timezone: "Asia/Kolkata" }).where(eq(tenants.id, t.tenantId));
    afterAll(() => setHours(null));

    it("a time in the past, outside clinic hours, or on a closed Sunday is refused and saves neither the call nor a visit", async () => {
      await setHours(HOURS);
      let sunday = addDays(dayKeyIn(new Date(), "Asia/Kolkata"), 2);
      while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
      const { journeyId } = await journey();
      for (const [at, reason] of [[new Date(Date.now() - 3_600_000).toISOString(), "appointment_time_in_past"], [`${sunday}T10:00`, "outside_clinic_hours"], [`${addDays(sunday, 1)}T18:00`, "outside_clinic_hours"]] as const) {
        const res = await logCall(journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId, confirmed: true } });
        expect(res.statusCode, at).toBe(422);
        expect(res.json()).toEqual({ error: reason });
      }
      expect(await db.select().from(calls).where(eq(calls.journeyId, journeyId))).toHaveLength(0);
      expect(await visits(journeyId)).toHaveLength(0);
    });

    it("a doctor who already has the slot refuses a second booking (409) and no second call is kept", async () => {
      await setHours(null);
      const at = inTwoDays();
      const first = await journey();
      expect((await logCall(first.journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId } })).statusCode).toBe(201);
      const second = await journey();
      const res = await logCall(second.journeyId, { appointment: { scheduledAt: at, doctorId, branchId: t.branchId } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "resource_unavailable" });
      expect(await db.select().from(calls).where(eq(calls.journeyId, second.journeyId))).toHaveLength(0);
    });
  });

  it("asking for a callback AND a visit is refused: one next action", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { callback: { dueAt: new Date(Date.now() + 3_600_000).toISOString() }, appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId } });
    expect(res.statusCode).toBe(400);
  });

  it("a role without appointment permission cannot book through a call", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId, branchId: t.branchId } }, "DOCTOR");
    expect([401, 403]).toContain(res.statusCode);
    expect(await visits(journeyId)).toHaveLength(0);
  });

  it("another hospital's doctor or branch is refused (never booked across tenants)", async () => {
    const { journeyId } = await journey();
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays(), doctorId: randomUUID(), branchId: t.branchId } });
    expect(res.statusCode).toBe(404);
    expect(await visits(journeyId)).toHaveLength(0);
  });

  it("a blank doctor/branch resolves to the hospital's only one, and is refused when there is a choice", async () => {
    const { journeyId } = await journey();
    const active = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, t.tenantId), eq(scheduleResources.isActive, true)));
    const res = await logCall(journeyId, { appointment: { scheduledAt: inTwoDays() } });
    if (active.length === 1) {
      expect(res.statusCode).toBe(201);
      expect((await visits(journeyId))[0]!.resourceId).toBe(active[0]!.id);
    } else {
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: "doctor_required" });
    }
  });
});

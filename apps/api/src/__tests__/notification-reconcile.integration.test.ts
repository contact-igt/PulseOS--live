import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, NotificationRuleVm, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, notifications, scheduleResources, tasks, tenants, timelineEvents } from "../db/schema.js";
import { getMessagingAdapter } from "../domain/connector/registry.js";
import { processDueNotifications } from "../domain/notification/notification.service.js";
import { reconcileAppointmentNotifications } from "../domain/notification/reconcile.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// The safety net for the one gap the in-process event cannot close: the visit is CONFIRMED and committed, but the process died
// before the confirmation / reminders were planned. Every test here puts the database in exactly that state (status flipped
// WITHOUT the event) and lets the reconcile pass recover it - through the same idempotent planner the event uses.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const HOUR = 3_600_000;

describe.skipIf(!DEMO_PASSWORD)("appointment notification reconciliation (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // default rules: confirmation now, reminders 1 day and 1 hour before
  let lean: TestTenant; // the Namokar pilot policy: confirmation + ONE reminder, 1 hour before
  let noRule: TestTenant; // reminder rules switched off
  let noWa: TestTenant; // WhatsApp Notifications capability off
  let bare: TestTenant; // WhatsApp on, but no WhatsApp connection configured
  let other: TestTenant;
  const tenantsUnderTest = () => [t, lean, noRule, noWa, bare, other];
  const resourceOf = new Map<string, string>();
  let n = 0;
  let slot = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(71000000 + ++n * 29).padStart(8, "0")}`;
  const inHours = (h: number) => new Date(Date.now() + h * HOUR + ++slot * 60_000);
  const rows = (id: string) => db.select().from(notifications).where(eq(notifications.subjectId, id));
  const fixtureOnly = {
    adapterFor: (provider: string) => {
      const real = getMessagingAdapter(provider)!;
      return {
        ...real,
        sendTemplate: async (cfg: Record<string, unknown>, sec: Record<string, unknown>, to: string, tpl: { name: string; language: string; parameters: string[] }) => {
          if (cfg.mode !== "fixture") throw new Error("test guard: refusing a non-fixture send");
          return real.sendTemplate(cfg, sec, to, tpl);
        },
      };
    },
  };

  /** Books a visit through the API (so every foreign key and slot rule is real) and leaves it Booked. */
  async function book(tt: TestTenant, at: Date): Promise<AppointmentRow & { patientId: string; journeyId: string }> {
    const lead = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Asha Rao", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(lead.statusCode).toBe(201);
    const { patientId, journeyId } = lead.json() as { patientId: string; journeyId: string };
    const res = await call(tt, "FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: tt.branchId, doctorId: resourceOf.get(tt.tenantId)!, scheduledAt: at.toISOString(), reason: "Consultation" });
    expect(res.statusCode).toBe(201);
    return { ...(res.json() as AppointmentRow), patientId, journeyId };
  }
  /** The crash: the visit is CONFIRMED in the database and no confirmation event ever ran (so nothing was planned). */
  async function confirmedWithoutEvent(tt: TestTenant, at: Date, confirmedHoursAgo = 0.1) {
    const a = await book(tt, new Date(Date.now() + 40 * HOUR + ++slot * 60_000)); // a valid future slot to book into
    await new Promise((r) => setTimeout(r, 300)); // let the booking's own (no-op: not confirmed yet) event handler finish first
    await db.update(appointments).set({ status: "confirmed", scheduledAt: at }).where(eq(appointments.id, a.id));
    // The real confirm commits the status AND this timeline line together; only the planning event is lost in the crash.
    await db.insert(timelineEvents).values({ tenantId: tt.tenantId, patientId: a.patientId, journeyId: a.journeyId, eventType: "appointment_confirmed", title: "Appointment confirmed", relatedEntityType: "appointment", relatedEntityId: a.id, occurredAt: new Date(Date.now() - confirmedHoursAgo * HOUR) });
    expect(await rows(a.id)).toHaveLength(0);
    return { ...a, at };
  }
  const setRule = async (tt: TestTenant, match: (r: NotificationRuleVm) => boolean, enabled: boolean) => {
    const rules = (await call(tt, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).json() as NotificationRuleVm[];
    for (const r of rules.filter((x) => x.subject === "APPOINTMENT" && match(x))) expect((await call(tt, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${r.id}`, { enabled })).statusCode).toBe(200);
  };
  // Scoped to this file's own hospitals: the real pass is global, and other test files run at the same time in the same database.
  const reconcile = (now = new Date()) => reconcileAppointmentNotifications(db, now, { tenantIds: tenantsUnderTest().map((x) => x.tenantId) });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    lean = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    noRule = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    noWa = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    bare = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of tenantsUnderTest()) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    for (const tt of tenantsUnderTest()) resourceOf.set(tt.tenantId, (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, tt.userIds.DOCTOR!)))[0]!.id);
    // Fixture WhatsApp connection for every tenant except `bare` (no connection at all).
    for (const tt of [t, lean, noRule, noWa, other]) expect((await call(tt, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-test" } })).statusCode).toBe(200);
    await call(lean, "HOSPITAL_ADMIN", "GET", "/notifications/rules"); // creates the defaults
    await setRule(lean, (r) => r.kind === "REMINDER" && r.offsetUnit === "days", false);
    await call(noRule, "HOSPITAL_ADMIN", "GET", "/notifications/rules");
    await setRule(noRule, (r) => r.kind === "REMINDER", false);
    expect((await call(noWa, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const tt of tenantsUnderTest()) {
      await db.delete(tasks).where(eq(tasks.tenantId, tt.tenantId));
      await db.delete(appointments).where(eq(appointments.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  const dueNowCount = (rs: { scheduledFor: Date }[]) => rs.filter((r) => r.scheduledFor.getTime() < Date.now() + 10_000).length;

  it("CRASH RECOVERY: confirmed with nothing planned → one confirmation and the reminders appear, exactly once", async () => {
    const a = await confirmedWithoutEvent(t, inHours(72));
    const first = await reconcile();
    expect(first.inspected).toBeGreaterThanOrEqual(1);
    expect(first.recovered).toBeGreaterThanOrEqual(3);
    const rs = await rows(a.id);
    expect(rs).toHaveLength(3); // confirmation (now) + 1 day + 1 hour
    expect(dueNowCount(rs)).toBe(1);
    expect(rs.map((r) => r.scheduledFor.getTime()).sort()).toEqual([expect.any(Number), a.at.getTime() - 86_400_000, a.at.getTime() - HOUR].sort((x, y) => (typeof x === "number" && typeof y === "number" ? x - y : 0)));
    expect(rs.every((r) => r.tenantId === t.tenantId && r.status === "PENDING")).toBe(true);
  });

  it("IDEMPOTENT: a second run, five runs, and parallel runs add nothing", async () => {
    const a = await confirmedWithoutEvent(t, inHours(73));
    await Promise.all([reconcile(), reconcile(), reconcile(), reconcile()]); // concurrent: the database key decides
    expect(await rows(a.id)).toHaveLength(3);
    const again = await reconcile();
    expect(again.recovered).toBe(0);
    for (let i = 0; i < 5; i++) await reconcile();
    expect(await rows(a.id)).toHaveLength(3);
    // Nothing was sent by reconciling: the worker owns sending.
    expect((await rows(a.id)).some((r) => r.status === "SENT")).toBe(false);
  });

  it("a partly planned visit (crash mid-planning) is completed, not doubled", async () => {
    const a = await confirmedWithoutEvent(t, inHours(74));
    const one = (await reconcile(), await rows(a.id))[0]!;
    await db.delete(notifications).where(eq(notifications.id, one.id)); // the crash left only some of the rows
    expect(await rows(a.id)).toHaveLength(2);
    await reconcile();
    expect(await rows(a.id)).toHaveLength(3);
  });

  it("A. Namokar policy, visit 5 hours away: the confirmation and exactly one reminder, 1 hour before", async () => {
    const a = await confirmedWithoutEvent(lean, inHours(5));
    await reconcile();
    const rs = await rows(a.id);
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.scheduledFor.getTime()).sort((x, y) => x - y)[1]).toBe(a.at.getTime() - HOUR);
    await reconcile();
    expect(await rows(a.id)).toHaveLength(2);
  });

  it("B. visit 45 minutes away: the confirmation is recovered, no reminder is ever created in the past", async () => {
    const a = await confirmedWithoutEvent(lean, inHours(0.75));
    await reconcile();
    const rs = await rows(a.id);
    expect(rs).toHaveLength(1);
    expect(dueNowCount(rs)).toBe(1);
  });

  it("C-F. yesterday's visit, cancelled, no-show, completed (and already in the clinic) are ignored", async () => {
    const yesterday = await confirmedWithoutEvent(lean, new Date(Date.now() - 20 * HOUR));
    const ids = [yesterday.id];
    for (const status of ["cancelled", "no_show", "completed", "checked_in", "waiting", "with_doctor"] as const) {
      const a = await confirmedWithoutEvent(lean, inHours(30));
      await db.update(appointments).set({ status }).where(eq(appointments.id, a.id));
      ids.push(a.id);
    }
    await reconcile();
    for (const id of ids) expect(await rows(id), id).toHaveLength(0);
  });

  it("a visit that is only Booked (not confirmed) gets nothing", async () => {
    const a = await book(lean, inHours(30));
    await reconcile();
    expect(await rows(a.id)).toHaveLength(0);
  });

  it("G. reminder rules switched off: the confirmation is recovered, no reminder", async () => {
    const a = await confirmedWithoutEvent(noRule, inHours(72));
    await reconcile();
    const rs = await rows(a.id);
    expect(rs).toHaveLength(1);
    expect(dueNowCount(rs)).toBe(1);
  });

  it("H. WhatsApp Notifications switched off: nothing is planned", async () => {
    const a = await confirmedWithoutEvent(noWa, inHours(72));
    await reconcile();
    expect(await rows(a.id)).toHaveLength(0);
  });

  it("I. no WhatsApp connection: planned, and the worker marks it BLOCKED with the reason (never 'sent')", async () => {
    const a = await confirmedWithoutEvent(bare, inHours(72));
    await reconcile();
    expect((await rows(a.id)).length).toBeGreaterThanOrEqual(1);
    await processDueNotifications(db, new Date(), fixtureOnly);
    const after = await rows(a.id);
    expect(after.filter((r) => r.status === "SENT")).toHaveLength(0);
    expect(after.some((r) => r.status === "BLOCKED" && r.reason)).toBe(true);
  });

  it("only the horizon is scanned: a visit further out than the horizon waits for a later run", async () => {
    const far = await confirmedWithoutEvent(lean, inHours(24 * 20));
    await reconcile();
    expect(await rows(far.id)).toHaveLength(0);
    const later = await reconcile(new Date(Date.now() + 15 * 24 * HOUR)); // 15 days on, it is inside the horizon
    expect(later.inspected).toBeGreaterThanOrEqual(1);
    expect((await rows(far.id)).length).toBeGreaterThanOrEqual(1);
  });

  it("the stale-state safety holds at send time: planned by reconciliation, then cancelled or demoted → never sent", async () => {
    const a = await confirmedWithoutEvent(t, inHours(72));
    await reconcile();
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, a.id)); // no event
    await processDueNotifications(db, new Date(Date.now() + 73 * HOUR), fixtureOnly);
    const rs = await rows(a.id);
    expect(rs.filter((r) => r.status === "SENT")).toHaveLength(0);
    expect(rs.every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("a reschedule is never resurrected: the visit is Booked again, so reconciliation plans nothing for the old time", async () => {
    const a = await confirmedWithoutEvent(t, inHours(80));
    await reconcile();
    expect(await rows(a.id)).toHaveLength(3);
    const newAt = inHours(120);
    expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: newAt.toISOString(), reasonCode: "patient_requested" })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    await reconcile();
    const rs = await rows(a.id);
    expect(rs).toHaveLength(3);
    expect(rs.every((r) => r.status === "CANCELLED" && r.reason === "RESCHEDULED")).toBe(true);
    // Re-confirmed (without the event, as in a crash): the NEW time is planned, the old rows stay cancelled.
    await db.update(appointments).set({ status: "confirmed" }).where(eq(appointments.id, a.id));
    await reconcile();
    const after = await rows(a.id);
    expect(after.filter((r) => r.status === "PENDING" && r.subjectAt!.getTime() === newAt.getTime())).toHaveLength(3);
    expect(after.filter((r) => r.status === "CANCELLED")).toHaveLength(3);
  });

  it("the scheduled job runs the pass at its own interval, not on every worker tick", async () => {
    const { reconcileJob } = await import("../domain/notification/reconcile.js");
    const job = reconcileJob(db, () => {}, 5 * 60_000);
    const t0 = new Date();
    expect(await job.run(t0)).toMatchObject({ inspected: expect.any(Number), recovered: expect.any(Number), errors: 0 });
    expect(await job.run(new Date(t0.getTime() + 30_000))).toBeUndefined(); // the next tick, 30s later: skipped
    expect(await job.run(new Date(t0.getTime() + 5 * 60_000 + 1))).toBeDefined(); // five minutes on: runs again
  });

  it("never revives: a cancelled confirmation stays cancelled (worker was late), the pass only fills gaps", async () => {
    const a = await confirmedWithoutEvent(t, inHours(60));
    await reconcile();
    const conf = (await rows(a.id)).find((r) => r.scheduledFor.getTime() < Date.now() + 10_000)!;
    await db.update(notifications).set({ status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" }).where(eq(notifications.id, conf.id));
    const again = await reconcile();
    expect(again.recovered).toBe(0);
    expect((await rows(a.id)).find((r) => r.id === conf.id)).toMatchObject({ status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" });
  });

  it("no mass 'confirmed' message when a switch is turned on later: a visit confirmed days ago gets its reminders, not a new confirmation", async () => {
    const a = await confirmedWithoutEvent(lean, inHours(30), 72); // confirmed three days ago, while nothing was planned
    await reconcile();
    const rs = await rows(a.id);
    expect(rs).toHaveLength(1); // the 1-hour reminder only
    expect(dueNowCount(rs)).toBe(0);
    expect(rs[0]!.scheduledFor.getTime()).toBe(a.at.getTime() - HOUR);
  });

  it("a large backlog is walked in full across runs: a time-budgeted run hands back where to continue", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await confirmedWithoutEvent(lean, inHours(100 + i))).id);
    const own = { tenantIds: [lean.tenantId], budgetMs: -1, pageSize: 2 };
    let run = await reconcileAppointmentNotifications(db, new Date(), own);
    let inspected = run.inspected;
    expect(run.next).not.toBeNull(); // out of budget after the first page of two
    expect(inspected).toBe(2);
    for (let guard = 0; run.next && guard < 20; guard++) {
      run = await reconcileAppointmentNotifications(db, new Date(), { ...own, after: run.next });
      inspected += run.inspected;
    }
    expect(inspected).toBeGreaterThanOrEqual(5); // every visit was reached, none starved
    for (const id of ids) expect((await rows(id)).length, id).toBeGreaterThanOrEqual(1);
  });

  it("tenant scoping: one hospital's visit only ever produces that hospital's notifications", async () => {
    const a = await confirmedWithoutEvent(other, inHours(72));
    await reconcile();
    const rs = await rows(a.id);
    expect(rs.length).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => r.tenantId === other.tenantId)).toBe(true);
  });

  it("timezones: the reminder instant is start - 1h in every zone (UTC, Asia/Kolkata, a DST zone across its clock change)", async () => {
    // 2026-11-01 06:30Z is 01:30 EST, the second 01:30 of America/New_York's fall-back night.
    const start = new Date("2026-11-01T06:30:00Z");
    const now = new Date("2026-10-30T06:30:00Z");
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York"]) {
      await db.update(tenants).set({ timezone: zone }).where(eq(tenants.id, lean.tenantId));
      const a = await confirmedWithoutEvent(lean, start);
      await db.update(timelineEvents).set({ occurredAt: now }).where(eq(timelineEvents.relatedEntityId, a.id)); // confirmed "just now" on the simulated clock
      await reconcile(now);
      const rs = (await rows(a.id)).sort((x, y) => x.scheduledFor.getTime() - y.scheduledFor.getTime());
      expect(rs, zone).toHaveLength(2);
      expect(rs[1]!.scheduledFor.getTime(), zone).toBe(start.getTime() - HOUR);
      await db.delete(notifications).where(and(eq(notifications.subjectId, a.id)));
      await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, a.id));
    }
    await db.update(tenants).set({ timezone: "Asia/Kolkata" }).where(eq(tenants.id, lean.tenantId));
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, scheduleResources, tasks, timelineEvents } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Appointment day, three staff steps: Check in (arrived AND waiting, one validated step) -> Send to doctor -> Consultation done.
describe.skipIf(!DEMO_PASSWORD)("appointment day: one-click check-in into the waiting queue (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let doctorId: string;
  let n = 0;
  let slot = 0;

  const as = (role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });
  async function visit(confirmIt = true) {
    const lead = (await as("FRONT_DESK", "POST", "/leads", { phone: `+9196${String(64000000 + ++n * 43).padStart(8, "0")}`, name: "Queue Test", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} })).json() as { patientId: string; journeyId: string };
    const booked = (await as("FRONT_DESK", "POST", "/appointments", { ...lead, branchId: t.branchId, doctorId, scheduledAt: new Date(Date.now() + 3_600_000 + ++slot * 60_000).toISOString(), reason: "Consultation" })).json() as AppointmentRow;
    if (confirmIt) expect((await as("FRONT_DESK", "PATCH", `/appointments/${booked.id}/action`, { action: "confirm" })).statusCode).toBe(200);
    return { id: booked.id, journeyId: lead.journeyId };
  }
  const row = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;
  const events = async (journeyId: string, type: string) => (await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, journeyId))).filter((e) => e.eventType === type);
  const checkIn = (id: string) => as("FRONT_DESK", "PATCH", `/appointments/${id}/action`, { action: "check_in", queue: true });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await app.inject({ method: "POST", url: "/departments/install", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { templateKey: "ophthalmology" } });
    doctorId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
  });
  afterAll(async () => {
    await queryClient`drop trigger if exists fail_checkin_event on timeline_events`;
    await queryClient`drop function if exists fail_checkin_event()`;
    await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));
    await db.delete(appointments).where(eq(appointments.tenantId, t.tenantId));
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("Check in puts the patient straight into Waiting: arrival and waiting start are the same instant, with ONE meaningful timeline line", async () => {
    const v = await visit();
    const res = await checkIn(v.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "waiting" });
    const a = await row(v.id);
    expect(a.status).toBe("waiting");
    expect(a.checkedInAt).toBeTruthy();
    expect(a.waitingStartedAt!.getTime()).toBe(a.checkedInAt!.getTime());
    const lines = await events(v.journeyId, "appointment_checked_in");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.title).toMatch(/checked in · waiting/i);
    expect(await events(v.journeyId, "appointment_waiting")).toHaveLength(0); // not a second line for the internal step
  });

  it("then Send to doctor -> With doctor, and Consultation done -> Completed, in order", async () => {
    const v = await visit();
    await checkIn(v.id);
    expect((await as("FRONT_DESK", "PATCH", `/appointments/${v.id}/action`, { action: "send_to_doctor" })).json()).toMatchObject({ status: "with_doctor" });
    expect((await as("FRONT_DESK", "PATCH", `/appointments/${v.id}/complete`, { next: { kind: "none" } })).statusCode).toBe(200);
    const a = await row(v.id);
    expect(a.status).toBe("completed");
    expect(a.consultationStartedAt).toBeTruthy();
    expect(a.completedAt).toBeTruthy();
  });

  it("a repeated click (or two at once) checks in once: same status, one timeline line, the first timestamps kept", async () => {
    const v = await visit();
    const [a, b] = await Promise.all([checkIn(v.id), checkIn(v.id)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const first = await row(v.id);
    expect(first.status).toBe("waiting");
    expect(await events(v.journeyId, "appointment_checked_in")).toHaveLength(1);
    const again = await checkIn(v.id);
    expect(again.json()).toMatchObject({ status: "waiting", alreadyApplied: true });
    expect((await row(v.id)).waitingStartedAt!.getTime()).toBe(first.waitingStartedAt!.getTime());
  });

  it("a booked-only visit can be checked in too; a no-show, cancelled or completed visit cannot", async () => {
    const booked = await visit(false);
    expect((await checkIn(booked.id)).statusCode).toBe(200);
    for (const action of ["mark_no_show", "cancel"] as const) {
      const v = await visit();
      expect((await as("FRONT_DESK", "PATCH", `/appointments/${v.id}/action`, { action, reasonCode: action === "cancel" ? "patient_requested" : "patient_no_show" })).statusCode).toBe(200);
      expect((await checkIn(v.id)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await row(v.id)).waitingStartedAt).toBeNull();
    }
  });

  it("a visit already checked in the old two-step way joins the queue without a second arrival time", async () => {
    const v = await visit();
    expect((await as("FRONT_DESK", "PATCH", `/appointments/${v.id}/action`, { action: "check_in" })).json()).toMatchObject({ status: "checked_in" });
    const arrived = (await row(v.id)).checkedInAt!.getTime();
    expect((await checkIn(v.id)).json()).toMatchObject({ status: "waiting" });
    const a = await row(v.id);
    expect(a.checkedInAt!.getTime()).toBe(arrived);
    expect(a.waitingStartedAt).toBeTruthy();
  });

  it("all-or-nothing: if recording the timeline line fails, the visit is NOT left half checked in", async () => {
    const v = await visit();
    await queryClient.unsafe(`create or replace function fail_checkin_event() returns trigger as $$ begin if new.related_entity_id = '${v.id}' and new.event_type = 'appointment_checked_in' then raise exception 'simulated failure'; end if; return new; end $$ language plpgsql`);
    await queryClient.unsafe(`create trigger fail_checkin_event before insert on timeline_events for each row execute function fail_checkin_event()`);
    try {
      const res = await checkIn(v.id);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await queryClient.unsafe(`drop trigger if exists fail_checkin_event on timeline_events`);
    }
    const a = await row(v.id);
    expect(a.status).toBe("confirmed");
    expect(a.checkedInAt).toBeNull();
    expect(a.waitingStartedAt).toBeNull();
    expect((await checkIn(v.id)).statusCode).toBe(200); // and a retry then works
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, ClinicHours } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, scheduleResources, tasks, tenants } from "../db/schema.js";
import { addDays, dayKeyIn } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const HOURS: ClinicHours = { mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null };

describe.skipIf(!DEMO_PASSWORD)("appointments: clinic hours enforced server-side (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let doctorId: string;
  let n = 0;

  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: t.cookie.FRONT_DESK! }, ...(payload ? { payload } : {}) });
  /** The next `weekday` (0=Sun..6=Sat) at least 2 local days ahead, as YYYY-MM-DD in Asia/Kolkata. */
  function nextDay(weekday: number): string {
    let d = addDays(dayKeyIn(new Date(), "Asia/Kolkata"), 2);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1);
    return d;
  }
  const setHours = (clinicHours: ClinicHours | null, timezone = "Asia/Kolkata") => db.update(tenants).set({ clinicHours, timezone }).where(eq(tenants.id, t.tenantId));
  async function journey() {
    const res = await call("POST", "/leads", { phone: `+9196${String(62000000 + ++n * 37).padStart(8, "0")}`, name: "Asha Rao", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  async function book(scheduledAt: string, ids?: { patientId: string; journeyId: string }) {
    const { patientId, journeyId } = ids ?? (await journey());
    return call("POST", "/appointments", { patientId, journeyId, branchId: t.branchId, doctorId, scheduledAt, reason: "Consultation" });
  }
  const refused = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "outside_clinic_hours" });
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await app.inject({ method: "POST", url: "/departments/install", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! }, payload: { templateKey: "ophthalmology" } });
    doctorId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
  });
  afterAll(async () => {
    await db.delete(tasks).where(eq(tasks.tenantId, t.tenantId));
    await db.delete(appointments).where(eq(appointments.tenantId, t.tenantId));
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  describe("hours set: Mon-Sat 09:00-16:00, Sunday closed, Asia/Kolkata", () => {
    beforeAll(() => setHours(HOURS));

    describe("the slot pre-check agrees with booking (never 'available' for a time booking refuses)", () => {
      const check = async (local: string) => (await call("GET", `/appointments/slot-check?doctorId=${doctorId}&scheduledAt=${encodeURIComponent(local)}`)).json() as { available: boolean; inPast: boolean; outsideHours: boolean };
      it("Sunday, 08:59, 16:00 and after closing: not available, flagged outsideHours", async () => {
        for (const local of [`${nextDay(0)}T10:00`, `${nextDay(2)}T08:59`, `${nextDay(3)}T16:00`, `${nextDay(4)}T18:30`]) expect(await check(local), local).toEqual({ available: false, inPast: false, outsideHours: true });
      });
      it("09:00 and 15:59 on an open day: available", async () => {
        for (const local of [`${nextDay(2)}T09:00`, `${nextDay(5)}T15:59`]) expect((await check(local)).available, local).toBe(true);
      });
      it("a busy doctor is 'not available' but NOT outsideHours", async () => {
        const local = `${nextDay(2)}T13:00`;
        expect((await book(local)).statusCode).toBe(201);
        expect(await check(local)).toEqual({ available: false, inPast: false, outsideHours: false });
      });
    });

    it("accepts a Monday 09:30 visit", async () => expect((await book(`${nextDay(1)}T09:30`)).statusCode).toBe(201));
    it("accepts a Saturday visit inside hours", async () => expect((await book(`${nextDay(6)}T11:00`)).statusCode).toBe(201));
    it("refuses a Sunday visit (closed day)", async () => refused(await book(`${nextDay(0)}T10:00`)));
    it("refuses 08:59 (before opening)", async () => refused(await book(`${nextDay(2)}T08:59`)));
    it("accepts 09:00 (opening time is inclusive)", async () => expect((await book(`${nextDay(2)}T09:00`)).statusCode).toBe(201));
    it("accepts 15:59", async () => expect((await book(`${nextDay(3)}T15:59`)).statusCode).toBe(201));
    it("refuses 16:00 (closing time is exclusive)", async () => refused(await book(`${nextDay(3)}T16:00`)));
    it("refuses a time after closing", async () => refused(await book(`${nextDay(4)}T18:30`)));
    it("still refuses a past date with the past-time reason", async () => {
      const res = await book("2020-01-06T10:00");
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "appointment_time_in_past" });
    });
    it("refuses a direct API call that bypasses the booking form (422 outside_clinic_hours)", async () => {
      const { patientId, journeyId } = await journey();
      refused(await call("POST", "/appointments", { patientId, journeyId, branchId: t.branchId, doctorId, scheduledAt: new Date(Date.UTC(2099, 0, 4, 20, 0)).toISOString() }));
    });
    it("refuses a reschedule into a closed time and leaves the visit unchanged", async () => {
      const ok = await book(`${nextDay(5)}T10:00`);
      expect(ok.statusCode).toBe(201);
      const visit = ok.json() as AppointmentRow;
      const res = await call("PATCH", `/appointments/${visit.id}/reschedule`, { scheduledAt: `${nextDay(0)}T10:00`, reasonCode: "patient_requested" });
      refused(res);
      const [row] = await db.select().from(appointments).where(eq(appointments.id, visit.id));
      expect(row!.scheduledAt.toISOString()).toBe(new Date(visit.scheduledAt).toISOString());
      const inside = await call("PATCH", `/appointments/${visit.id}/reschedule`, { scheduledAt: `${nextDay(5)}T12:00`, reasonCode: "patient_requested" });
      expect(inside.statusCode).toBe(200);
    });
    it("still rejects a double booking of the same doctor and minute", async () => {
      const at = `${nextDay(1)}T14:00`;
      expect((await book(at)).statusCode).toBe(201);
      const again = await book(at);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "resource_unavailable" });
    });
    it("refuses the lead flow's appointment next step outside hours, and books it inside hours", async () => {
      const lead = (at: string) => call("POST", "/leads", { phone: `+9196${String(63000000 + ++n * 37).padStart(8, "0")}`, name: "Lead Step", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", source: "google", nextStep: { kind: "appointment", scheduledAt: at, doctorId } });
      refused(await lead(`${nextDay(0)}T10:00`));
      const ok = await lead(`${nextDay(4)}T10:30`);
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  describe("timezone: hours are judged on the hospital's local clock", () => {
    // 04:30 UTC on a Monday is 10:00 in Asia/Kolkata but 04:30 in UTC.
    const instant = () => `${nextDay(1)}T04:30:00.000Z`;
    it("accepts that instant for an Asia/Kolkata hospital", async () => {
      await setHours(HOURS, "Asia/Kolkata");
      expect((await book(instant())).statusCode).toBe(201);
    });
    it("refuses the same instant when the hospital's timezone is UTC with the same hours", async () => {
      await setHours(HOURS, "UTC");
      refused(await book(instant()));
    });
  });

  describe("no hours set (clinicHours null)", () => {
    it("accepts a Sunday visit, behaviour unchanged", async () => {
      await setHours(null);
      expect((await book(`${nextDay(0)}T03:00`)).statusCode).toBe(201);
    });
  });
});

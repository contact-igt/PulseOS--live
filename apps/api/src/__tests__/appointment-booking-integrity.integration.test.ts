import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, Role, ScheduleResourceVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, scheduleResources } from "../db/schema.js";
import { createAppointment } from "../domain/appointment/appointment.service.js";
import { parseInstant, zonedWallTime } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const IST = "Asia/Kolkata";

describe("instants from clients (unit)", () => {
  it("an offset-less local date-time is HOSPITAL time, whatever the server zone; an explicit instant is kept", () => {
    expect(parseInstant("2026-10-02T09:00", IST)?.toISOString()).toBe("2026-10-02T03:30:00.000Z");
    expect(parseInstant("2026-10-02 09:00:30", IST)?.toISOString()).toBe("2026-10-02T03:30:30.000Z");
    expect(parseInstant("2026-10-02T09:00", "UTC")?.toISOString()).toBe("2026-10-02T09:00:00.000Z");
    expect(parseInstant("2026-10-02T03:30:00.000Z", IST)?.toISOString()).toBe("2026-10-02T03:30:00.000Z");
    expect(parseInstant("2026-10-02T09:00:00+05:30", "UTC")?.toISOString()).toBe("2026-10-02T03:30:00.000Z");
    // A wall time inside a DST gap does not exist and is refused, not quietly moved to another hour.
    expect(parseInstant("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(parseInstant("2026-03-08T03:30", "America/New_York")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(parseInstant("2026-11-01T01:30", "America/New_York")).not.toBeNull(); // an ambiguous hour still resolves to one real instant
    expect(parseInstant("2026-02-30T10:00", IST)).toBeNull();
    expect(parseInstant("not a date", IST)).toBeNull();
    expect(parseInstant("", IST)).toBeNull();
    expect(parseInstant(undefined, IST)).toBeNull();
  });
});

describe.skipIf(!DEMO_PASSWORD)("appointment booking integrity (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  let doctorA: string; // resource linked to the Doctor login
  let doctorB: string; // a second doctor, no login
  let foreignDoctor: string;
  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const phone = () => `+9197${String(61000000 + ++n * 37).padStart(8, "0")}`;
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: as(tt, role), ...(payload ? { payload } : {}) });

  /** A future hospital slot, `d` days out at hh:mm hospital time — distinct per test so slots never collide by accident. */
  const slot = (d: number, hh: number, mm = 0) => {
    const day = new Date(Date.now() + d * 86_400_000).toLocaleDateString("en-CA", { timeZone: IST });
    return zonedWallTime(day, hh, mm, IST).toISOString();
  };

  async function patient(tt: TestTenant = t) {
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Booking Patient", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  async function bookRaw(opts: { tt?: TestTenant; doctorId: string; at: string; who?: { patientId: string; journeyId: string } }) {
    const tt = opts.tt ?? t;
    const p = opts.who ?? (await patient(tt));
    return call(tt, "FRONT_DESK", "POST", "/appointments", { patientId: p.patientId, journeyId: p.journeyId, branchId: tt.branchId, doctorId: opts.doctorId, scheduledAt: opts.at, reason: "Consultation" });
  }
  async function book(doctorId: string, at: string) {
    const res = await bookRaw({ doctorId, at });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as AppointmentRow;
  }
  const action = (id: string, body: object) => call(t, "FRONT_DESK", "PATCH", `/appointments/${id}/action`, body);
  const reschedule = (id: string, scheduledAt: string, reasonCode = "patient_requested") => call(t, "FRONT_DESK", "PATCH", `/appointments/${id}/reschedule`, { scheduledAt, reasonCode });

  beforeAll(async () => {
    app = await buildApp();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    const [a] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, t.tenantId), eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)));
    doctorA = a!.id;
    const created = await call(t, "HOSPITAL_ADMIN", "POST", "/resources", { name: "Dr Second" });
    doctorB = (created.json() as ScheduleResourceVm).id;
    const [f] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.tenantId, other.tenantId));
    foreignDoctor = f!.id;
  });

  afterAll(async () => {
    if (t) await destroyTestTenant(db, t);
    if (other) await destroyTestTenant(db, other);
    await app?.close();
    await queryClient.end();
  });

  describe("past times", () => {
    it("a future time is accepted", async () => {
      expect((await bookRaw({ doctorId: doctorA, at: slot(3, 10) })).statusCode).toBe(201);
    });

    it("a past date and an earlier time today are refused with a domain error — never a 500 — and nothing is saved", async () => {
      const before = (await db.select().from(appointments).where(eq(appointments.tenantId, t.tenantId))).length;
      for (const at of [new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() - 3_600_000).toISOString(), "2020-01-01T10:00:00.000Z"]) {
        const res = await bookRaw({ doctorId: doctorA, at });
        expect(res.statusCode, at).toBe(422);
        expect(res.json()).toEqual({ error: "appointment_time_in_past" });
      }
      expect((await db.select().from(appointments).where(eq(appointments.tenantId, t.tenantId))).length).toBe(before);
    });

    it("a later time today is accepted", async () => {
      const res = await bookRaw({ doctorId: doctorB, at: new Date(Date.now() + 2 * 3_600_000).toISOString() });
      expect(res.statusCode, res.body).toBe(201);
    });

    it("a malformed time is a 400/422, not a 500", async () => {
      for (const at of ["", "yesterday", "2026-13-45T99:00"]) expect([400, 422], at).toContain((await bookRaw({ doctorId: doctorA, at })).statusCode);
    });

    it("the rule is on the hospital clock: around hospital midnight, while UTC is still on the previous day", async () => {
      const { patientId, journeyId } = await patient();
      const input = (scheduledAt: string, doctorId = doctorB) => ({ patientId, journeyId, branchId: t.branchId, doctorId, scheduledAt });
      const now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct — UTC is still 1 Oct
      const book1 = (at: string, doctorId?: string) => createAppointment(db, t.tenantId, t.userIds.FRONT_DESK!, input(at, doctorId), IST, now);
      // Offset-less strings are hospital wall time: 00:10 IST has passed, 01:00 IST has not.
      expect(await book1("2026-10-02T00:10")).toEqual({ ok: false, reason: "appointment_time_in_past" });
      // The same wall time read as UTC would be 05:40 IST — in the future. It must NOT be read that way.
      expect(await book1("2026-10-01T23:50:00.000Z")).toMatchObject({ ok: true }); // 05:20 IST on 2 Oct
      expect(await book1("2026-10-02T01:30", doctorA)).toMatchObject({ ok: true });
    });
  });

  describe("double booking", () => {
    it("the same doctor at the same time is refused with safe copy that names nobody", async () => {
      const at = slot(5, 10);
      await book(doctorA, at);
      const clash = await bookRaw({ doctorId: doctorA, at });
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toEqual({ error: "resource_unavailable" }); // no patient, id or time of the other visit
    });

    it("a different doctor at the same time, and the same doctor at another time, are fine", async () => {
      const at = slot(6, 10);
      await book(doctorA, at);
      await book(doctorB, at);
      await book(doctorA, slot(6, 10, 30));
    });

    it("another hospital's doctor is not found here, and another hospital's bookings never block this one", async () => {
      const at = slot(7, 10);
      expect((await bookRaw({ doctorId: foreignDoctor, at })).statusCode).toBe(404); // not this hospital's resource
      await bookRaw({ tt: other, doctorId: foreignDoctor, at });
      expect((await bookRaw({ doctorId: doctorA, at })).statusCode).toBe(201); // same instant, different hospital
    });

    it("cancelled and no-show visits free the slot; a completed or in-flight one still holds it", async () => {
      const at = slot(8, 10);
      const first = await book(doctorA, at);
      expect((await action(first.id, { action: "cancel", reasonCode: "patient_requested" })).statusCode).toBe(200);
      const second = await book(doctorA, at); // cancelled does not block
      expect((await bookRaw({ doctorId: doctorA, at })).statusCode).toBe(409); // second holds it
      expect((await action(second.id, { action: "mark_no_show", reasonCode: "patient_no_show" })).statusCode).toBe(200);
      const third = await book(doctorA, at); // no-show does not block either
      expect(third.id).not.toBe(second.id);
      for (const a of ["check_in", "mark_waiting", "send_to_doctor"]) expect((await action(third.id, { action: a })).statusCode).toBe(200);
      expect((await bookRaw({ doctorId: doctorA, at })).statusCode).toBe(409); // with the doctor now
    });

    it("the same minute is the same slot (seconds do not make a free slot)", async () => {
      const at = slot(9, 11);
      await book(doctorA, at);
      const clash = await bookRaw({ doctorId: doctorA, at: new Date(new Date(at).getTime() + 30_000).toISOString() });
      expect(clash.statusCode).toBe(409);
    });

    it("rescheduling onto an occupied slot is refused; into a free one works; its own slot is not a collision", async () => {
      const a = await book(doctorA, slot(10, 10));
      const b = await book(doctorA, slot(10, 11));
      const clash = await reschedule(b.id, slot(10, 10));
      expect(clash.statusCode).toBe(409);
      expect(clash.json()).toEqual({ error: "resource_unavailable" });
      expect((await reschedule(b.id, slot(10, 12))).statusCode).toBe(200);
      expect((await reschedule(a.id, slot(10, 10, 5))).statusCode).toBe(200); // moving by minutes off its own slot
      // Rebooking a no-show / cancelled visit re-activates it, so it must not land on someone else's slot.
      const c = await book(doctorA, slot(11, 10));
      expect((await action(c.id, { action: "cancel", reasonCode: "patient_requested" })).statusCode).toBe(200);
      await book(doctorA, slot(11, 10)); // takes the freed slot
      expect((await reschedule(c.id, slot(11, 10))).statusCode).toBe(409);
    });

    it("concurrent requests for one doctor and slot: exactly one wins", async () => {
      const at = slot(12, 10);
      const people = await Promise.all(Array.from({ length: 6 }, () => patient()));
      const results = await Promise.all(people.map((p) => bookRaw({ doctorId: doctorA, at, who: p })));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
      const rows = await db.select().from(appointments).where(and(eq(appointments.tenantId, t.tenantId), eq(appointments.resourceId, doctorA), sql`date_trunc('minute', ${appointments.scheduledAt}) = date_trunc('minute', ${at}::timestamptz)`));
      expect(rows.filter((r) => r.status !== "cancelled" && r.status !== "no_show")).toHaveLength(1);
    });

    it("concurrent reschedules into one free slot: exactly one wins", async () => {
      const [x, y] = await Promise.all([book(doctorB, slot(13, 9)), book(doctorB, slot(13, 9, 30))]);
      const target = slot(13, 15);
      const results = await Promise.all([reschedule(x.id, target), reschedule(y.id, target)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    });
  });

  describe("slot check (advisory pre-check for the form)", () => {
    const check = (tt: TestTenant, role: Role, doctorId: string, at: string) => call(tt, role, "GET", `/appointments/slot-check?doctorId=${doctorId}&scheduledAt=${encodeURIComponent(at)}`);

    it("says yes/no and never who holds the slot; the past is flagged", async () => {
      const at = slot(14, 10);
      await book(doctorA, at);
      const taken = await check(t, "FRONT_DESK", doctorA, at);
      expect(taken.json()).toEqual({ available: false, inPast: false, outsideHours: false });
      expect((await check(t, "FRONT_DESK", doctorB, at)).json()).toEqual({ available: true, inPast: false, outsideHours: false });
      expect((await check(t, "FRONT_DESK", doctorA, new Date(Date.now() - 86_400_000).toISOString())).json()).toEqual({ available: false, inPast: true, outsideHours: false });
    });

    it("needs the appointments permission, refuses junk, and another hospital's doctor is a 404", async () => {
      const at = slot(14, 11);
      expect((await app.inject({ method: "GET", url: `/appointments/slot-check?doctorId=${doctorA}&scheduledAt=${at}` })).statusCode).toBe(401);
      expect((await check(t, "FRONT_DESK", "not-a-uuid", at)).statusCode).toBe(400);
      expect((await check(t, "FRONT_DESK", doctorA, "soon")).statusCode).toBe(400);
      expect((await check(t, "FRONT_DESK", foreignDoctor, at)).statusCode).toBe(404);
    });
  });
});

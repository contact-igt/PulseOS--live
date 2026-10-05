import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, branches, consultationOutcomes, journeys, patients, tenants, timelineEvents, users } from "../db/schema.js";
import { getFrontDeskDashboard, listAppointments } from "../domain/appointment/appointment.service.js";
import { getDoctorDashboard } from "../domain/dashboard/doctor.service.js";
import type { AppointmentRow } from "@pulseos/types";

// Appointment calendar/day views bucket by the HOSPITAL's day (tenants.timezone),
// never the UTC date and never the API server's own clock zone. Each fixture is
// placed so its UTC date differs from its local date. Scratch tenants only.

describe("appointment views follow the tenant timezone (integration)", () => {
  const tenantIds: string[] = [];
  let ist: { tenantId: string; doctorId: string };
  let la: { tenantId: string; doctorId: string };
  const ids: Record<string, string> = {};

  async function makeTenant(name: string, timezone: string) {
    const [t] = await db.insert(tenants).values({ name, timezone }).returning();
    tenantIds.push(t.id);
    const [b] = await db.insert(branches).values({ tenantId: t.id, name: "Scratch Branch", city: "Scratch" }).returning();
    const [d] = await db
      .insert(users)
      .values({ tenantId: t.id, branchId: b.id, name: "Dr. Scratch", email: `scratch-${t.id}@example.test`, passwordHash: "x", role: "DOCTOR" })
      .returning();
    const [p] = await db.insert(patients).values({ tenantId: t.id, name: "Scratch Patient", phone: "+910000000000" }).returning();
    const [j] = await db.insert(journeys).values({ tenantId: t.id, patientId: p.id, journeyType: "Cataract", source: "walk_in" }).returning();
    const add = async (key: string, scheduledAt: string, status: typeof appointments.$inferInsert.status = "confirmed") => {
      const [a] = await db
        .insert(appointments)
        .values({ tenantId: t.id, patientId: p.id, journeyId: j.id, branchId: b.id, doctorUserId: d.id, scheduledAt: new Date(scheduledAt), status })
        .returning();
      ids[key] = a.id;
    };
    return { tenantId: t.id, doctorId: d.id, add };
  }

  beforeAll(async () => {
    const a = await makeTenant("Appt TZ Scratch IST", "Asia/Kolkata");
    // IST = UTC+5:30, so 18:30Z is local midnight.
    await a.add("istLate", "2025-03-10T18:29:00Z"); // 23:59 IST on the 10th
    await a.add("istMidnight", "2025-03-10T18:45:00Z"); // 00:15 IST on the 11th (UTC: still the 10th)
    await a.add("istMorning", "2025-03-11T04:30:00Z", "completed"); // 10:00 IST on the 11th
    await a.add("istNextWeek", "2025-03-17T05:00:00Z"); // Mon 17th
    await a.add("istNextMonth", "2025-04-01T03:30:00Z"); // 1 Apr
    ist = { tenantId: a.tenantId, doctorId: a.doctorId };

    const b = await makeTenant("Appt TZ Scratch LA", "America/Los_Angeles");
    // PDT = UTC-7 from 9 March 2025. 02:00Z on the 11th is 19:00 on the 10th locally.
    await b.add("laEvening", "2025-03-11T02:00:00Z");
    await b.add("laMorning", "2025-03-11T16:00:00Z"); // 09:00 on the 11th
    la = { tenantId: b.tenantId, doctorId: b.doctorId };
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await db.delete(consultationOutcomes).where(inArray(consultationOutcomes.tenantId, tenantIds));
      await db.delete(timelineEvents).where(inArray(timelineEvents.tenantId, tenantIds));
      await db.delete(appointments).where(inArray(appointments.tenantId, tenantIds));
      await db.delete(journeys).where(inArray(journeys.tenantId, tenantIds));
      await db.delete(patients).where(inArray(patients.tenantId, tenantIds));
      await db.delete(users).where(inArray(users.tenantId, tenantIds));
      await db.delete(branches).where(inArray(branches.tenantId, tenantIds));
      await db.delete(tenants).where(inArray(tenants.id, tenantIds));
    }
  });

  const idsOf = (rows: AppointmentRow[]) => rows.map((r) => r.id);

  it("?date= is the tenant's local day: IST 00:15 lands on its IST day, not the UTC day", async () => {
    const on10 = await listAppointments(db, ist.tenantId, { date: "2025-03-10" });
    const on11 = await listAppointments(db, ist.tenantId, { date: "2025-03-11" });
    expect(idsOf(on10)).toEqual([ids.istLate]);
    expect(idsOf(on11)).toEqual([ids.istMidnight, ids.istMorning]);
  });

  it("from/to is an inclusive local-day range (week and month views)", async () => {
    const week = await listAppointments(db, ist.tenantId, { from: "2025-03-10", to: "2025-03-16" });
    expect(idsOf(week)).toEqual([ids.istLate, ids.istMidnight, ids.istMorning]);
    const month = await listAppointments(db, ist.tenantId, { from: "2025-02-24", to: "2025-04-06" });
    expect(idsOf(month)).toEqual([ids.istLate, ids.istMidnight, ids.istMorning, ids.istNextWeek, ids.istNextMonth]);
    const single = await listAppointments(db, ist.tenantId, { from: "2025-03-11", to: "2025-03-11" });
    expect(idsOf(single)).toEqual(idsOf(await listAppointments(db, ist.tenantId, { date: "2025-03-11" })));
  });

  it("uses each tenant's own zone: a Los Angeles evening stays on the earlier local day", async () => {
    expect(idsOf(await listAppointments(db, la.tenantId, { date: "2025-03-10" }))).toEqual([ids.laEvening]);
    expect(idsOf(await listAppointments(db, la.tenantId, { date: "2025-03-11" }))).toEqual([ids.laMorning]);
  });

  it("front desk 'today' is the tenant's local today, not the server's", async () => {
    // 19:00Z on the 10th = 00:30 IST on the 11th = 12:00 PDT on the 10th.
    const instant = new Date("2025-03-10T19:00:00Z");
    const istDesk = await getFrontDeskDashboard(db, ist.tenantId, undefined, instant);
    expect(idsOf(istDesk.today)).toEqual([ids.istMidnight, ids.istMorning]);
    const laDesk = await getFrontDeskDashboard(db, la.tenantId, undefined, instant);
    expect(idsOf(laDesk.today)).toEqual([ids.laEvening]);
  });

  it("doctor home 'today' is the tenant's local today", async () => {
    const instant = new Date("2025-03-10T19:00:00Z");
    const dash = await getDoctorDashboard(db, ist.tenantId, ist.doctorId, instant);
    expect(dash.today.map((i) => i.appointmentId)).toEqual([ids.istMidnight, ids.istMorning]);
    const laDash = await getDoctorDashboard(db, la.tenantId, la.doctorId, instant);
    expect(laDash.today.map((i) => i.appointmentId)).toEqual([ids.laEvening]);
  });
});

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("appointment view endpoints (integration)", () => {
  let app: FastifyInstance;
  let frontDesk: string;
  let doctor: string;

  async function loginAs(email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
    return res.cookies.find((c) => c.name === "pulseos_session")!.value;
  }
  const get = (url: string, cookie: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    frontDesk = await loginAs("eye.frontdesk@pulseos.local");
    doctor = await loginAs("eye.doctor@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("GET /appointments/calendar-context returns the session tenant's zone and local today", async () => {
    const res = await get("/appointments/calendar-context", frontDesk);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { timezone: string; today: string };
    expect(body.timezone).toBe("Asia/Kolkata");
    expect(body.today).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
    // Doctors (VIEW_APPOINTMENTS only) can read it too.
    expect((await get("/appointments/calendar-context", doctor)).statusCode).toBe(200);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/appointments/calendar-context" });
    expect(res.statusCode).toBe(401);
  });

  it("from/to returns the same rows as the per-day query summed over the range", async () => {
    const all = (await get("/appointments", frontDesk)).json() as AppointmentRow[];
    const day = (await get("/appointments/calendar-context", frontDesk)).json().today as string;
    const range = (await get(`/appointments?from=${day}&to=${day}`, frontDesk)).json() as AppointmentRow[];
    const byDate = (await get(`/appointments?date=${day}`, frontDesk)).json() as AppointmentRow[];
    expect(range.map((r) => r.id)).toEqual(byDate.map((r) => r.id));
    expect(all.length).toBeGreaterThanOrEqual(range.length);
  });

  it.each([
    ["from=2025-13-01&to=2025-13-02", "invalid month"],
    ["from=2025-03-10", "to missing"],
    ["from=2025-03-10&to=2025-03-01", "from after to"],
    ["from=2025-01-01&to=2025-06-30", "range too long"],
    ["date=10-03-2025", "malformed date"],
  ])("rejects %s (%s) with 400 instead of a 500", async (qs) => {
    const res = await get(`/appointments?${qs}`, frontDesk);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

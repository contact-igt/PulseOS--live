import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { addDays } from "../lib/hospital-time.js";

// Front Desk and Doctor Home are "today" screens that can look at another hospital day (yesterday's no-shows, tomorrow's
// schedule). The day is a validated hospital-local YYYY-MM-DD; without it they stay on today.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("Front Desk / Doctor Home day navigation (integration)", () => {
  let app: FastifyInstance;
  let desk: string;
  let doctor: string;
  let tenantId: string;
  let doctorUserId: string;
  let tz: string;
  let today: string;

  const as = (cookie: string, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });
  const signIn = async (email: string) => (await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } })).cookies.find((c) => c.name === "pulseos_session")!.value;
  const onDay = async (day: string, extra = "") =>
    (await queryClient`
      select count(*)::int as c from appointments a
      where a.tenant_id = ${tenantId} and to_char(a.scheduled_at at time zone ${tz}, 'YYYY-MM-DD') = ${day} ${extra ? queryClient.unsafe(extra) : queryClient``}`)[0]!.c as number;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    desk = await signIn("namokar.frontdesk@pulseos.local");
    doctor = await signIn("namokar.doctor@pulseos.local");
    const [t] = await queryClient`select id, timezone from tenants where name = 'Namokar Eye & Oculoplasty Centre'`;
    tenantId = t!.id as string;
    tz = t!.timezone as string;
    today = (await queryClient`select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as d`)[0]!.d as string;
    doctorUserId = (await queryClient`select id from users where email = 'namokar.doctor@pulseos.local'`)[0]!.id as string;
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("Front Desk defaults to today and says which day it is showing", async () => {
    const res = (await as(desk, "/front-desk")).json();
    expect(res.date).toBe(today);
    expect(res.today).toHaveLength(await onDay(today));
    expect((await as(desk, `/front-desk?date=${today}`)).json().today).toHaveLength(res.today.length);
  });

  it("Front Desk shows exactly the appointments of another hospital day", async () => {
    for (const day of [addDays(today, -1), addDays(today, 1), addDays(today, 2), addDays(today, -5)]) {
      const res = (await as(desk, `/front-desk?date=${day}`)).json();
      expect(res.date).toBe(day);
      expect(res.today, day).toHaveLength(await onDay(day));
    }
  });

  it.each(["yesterday", "2026-02-31", "2026-9-1", "20261001", "2026-10-01T00:00"])("Front Desk refuses a bad date (%s) with 400", async (bad) => {
    expect((await as(desk, `/front-desk?date=${encodeURIComponent(bad)}`)).statusCode).toBe(400);
  });

  it("Doctor Home defaults to today and shows only that doctor's visits for another day", async () => {
    const todayView = (await as(doctor, "/dashboard/doctor")).json();
    expect(todayView.date).toBe(today);
    for (const day of [today, addDays(today, 1), addDays(today, -1)]) {
      const res = (await as(doctor, `/dashboard/doctor?date=${day}`)).json();
      expect(res.date).toBe(day);
      expect(res.todayCount, day).toBe(await onDay(day, `and a.doctor_user_id = '${doctorUserId}'`));
      expect(res.today).toHaveLength(res.todayCount);
    }
  });

  it("Doctor Home refuses a bad date with 400", async () => {
    expect((await as(doctor, "/dashboard/doctor?date=tomorrow")).statusCode).toBe(400);
  });
});

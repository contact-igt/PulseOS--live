import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { journeyConfigProblems } from "../seed/demo/consistency.js";
import { NAMOKAR_JOURNEYS, NAMOKAR_PATIENT_NAMES, NAMOKAR_TENANT_NAME } from "../seed/demo/namokar.js";

// The Namokar telecalling demo must hold its story: a realistic "today" (enquiries, a clinic queue in every state,
// this morning's calls) plus callbacks that are due today, overdue and coming up. Counts are relative to the hospital's
// day, so this needs a seed run on the same day (the seed is the only thing that creates this data).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe("Namokar journey configs", () => {
  it("contain no contradictory stage / appointment / outcome / treatment combination", () => {
    const problems = NAMOKAR_JOURNEYS.flatMap((c) => journeyConfigProblems(c).map((p) => `#${c.patientIdx} ${NAMOKAR_PATIENT_NAMES[c.patientIdx]}: ${p}`));
    expect(problems).toEqual([]);
  });

  it("use each patient once, with a name", () => {
    const idx = NAMOKAR_JOURNEYS.map((c) => c.patientIdx);
    expect(new Set(idx).size).toBe(idx.length);
    for (const i of idx) expect(NAMOKAR_PATIENT_NAMES[i]).toBeTruthy();
  });
});

describe.skipIf(!DEMO_PASSWORD)("Namokar Eye & Oculoplasty Centre pilot (seeded)", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let tz: string;
  let today: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const [t] = await queryClient`select id, timezone from tenants where name = ${NAMOKAR_TENANT_NAME}`;
    expect(t, "run `pnpm db:seed` first").toBeTruthy();
    tenantId = t!.id as string;
    tz = t!.timezone as string;
    today = ((await queryClient`select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as d`)[0]!.d as string);
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("is a V1, Asia/Kolkata ophthalmology hospital with the staff a telecalling team needs", async () => {
    const [t] = await queryClient`select edition, timezone from tenants where id = ${tenantId}`;
    expect(t).toMatchObject({ edition: "BETA_V1_CORE", timezone: "Asia/Kolkata" });
    const roles = (await queryClient`select role from users where tenant_id = ${tenantId} order by role`).map((r) => r.role as string);
    expect(roles).toEqual(expect.arrayContaining(["HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"]));
    expect((await queryClient`select 1 from departments where tenant_id = ${tenantId} and template_key = 'ophthalmology'`).length).toBe(1);
  });

  it("is the real pilot shape: one Ashok Vihar branch, one doctor (Dr. Poonam Jain), a receptionist and two coordinators; a one-hour reminder, not a one-day one", async () => {
    const br = await queryClient`select name, city from branches where tenant_id = ${tenantId}`;
    expect(br).toHaveLength(1);
    expect(br[0]!.city).toMatch(/Ashok Vihar/);
    const docs = await queryClient`select name from schedule_resources where tenant_id = ${tenantId} and is_active`;
    expect(docs.map((d) => d.name)).toEqual(["Dr. Poonam Jain"]);
    const staff = await queryClient`select role, count(*)::int as n from users where tenant_id = ${tenantId} and role in ('FRONT_DESK','PATIENT_COORDINATOR','DOCTOR') group by role`;
    expect(Object.fromEntries(staff.map((r) => [r.role, r.n]))).toEqual({ FRONT_DESK: 1, PATIENT_COORDINATOR: 2, DOCTOR: 1 });
    const rules = await queryClient`select kind, offset_unit, enabled from notification_rules where tenant_id = ${tenantId} and subject = 'APPOINTMENT'`;
    expect(rules.filter((r) => r.enabled && r.kind === "REMINDER").map((r) => r.offset_unit)).toEqual(["hours"]);
  });

  it("opened 8-12 new enquiries today, from every channel, across the services", async () => {
    const rows = await queryClient`
      select j.journey_type, j.source from journeys j
      where j.tenant_id = ${tenantId} and to_char(j.created_at at time zone ${tz}, 'YYYY-MM-DD') = ${today}`;
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.length).toBeLessThanOrEqual(12);
    const all = await queryClient`select distinct source from journeys where tenant_id = ${tenantId}`;
    expect(all.map((r) => r.source as string).sort()).toEqual(expect.arrayContaining(["google", "meta", "phone", "whatsapp", "referral", "walk_in"]));
    const sources = await queryClient`select distinct s.key from journeys j join lead_sources s on s.id = j.source_id where j.tenant_id = ${tenantId}`;
    expect(sources.map((r) => r.key as string)).toEqual(expect.arrayContaining(["instagram", "facebook"]));
    const services = (await queryClient`select distinct journey_type from journeys where tenant_id = ${tenantId}`).map((r) => r.journey_type as string);
    expect(services).toEqual(expect.arrayContaining(["Cataract", "Oculoplasty", "Laser Vision Correction", "General Eye Consultation"]));
  });

  it("has a full clinic queue today: 10 appointments in every state", async () => {
    const rows = await queryClient`
      select status, count(*)::int as c from appointments
      where tenant_id = ${tenantId} and to_char(scheduled_at at time zone ${tz}, 'YYYY-MM-DD') = ${today} group by status`;
    const by = Object.fromEntries(rows.map((r) => [r.status as string, r.c as number]));
    expect(by).toMatchObject({ completed: 4, with_doctor: 1, waiting: 1, checked_in: 1, no_show: 1 });
    expect((by.confirmed ?? 0) + (by.scheduled ?? 0)).toBe(2);
    expect(Object.values(by).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("logged this morning's calls: 4 incoming (1 missed), 5 outgoing (2 not connected)", async () => {
    const rows = await queryClient`
      select direction, status, count(*)::int as c from calls
      where tenant_id = ${tenantId} and to_char(started_at at time zone ${tz}, 'YYYY-MM-DD') = ${today} group by direction, status`;
    const get = (d: string, s: string) => rows.find((r) => r.direction === d && r.status === s)?.c ?? 0;
    expect(get("inbound", "completed") + get("inbound", "missed")).toBe(4);
    expect(get("inbound", "missed")).toBe(1);
    expect(get("outbound", "completed") + get("outbound", "no_answer")).toBe(5);
    expect(get("outbound", "no_answer")).toBe(2);
  });

  it("has follow-ups due today, overdue and coming up, plus an Appointment Risk and a Surgery Follow-up", async () => {
    const open = await queryClient`
      select t.reason, t.type, f.key as type_key, to_char(t.due_at at time zone ${tz}, 'YYYY-MM-DD') as due_day, (t.due_at < now()) as overdue
      from tasks t left join followup_types f on f.id = t.followup_type_id
      where t.tenant_id = ${tenantId} and t.status in ('pending','in_progress')`;
    // In the last half hour of the hospital day nothing can still be "later today".
    const [{ hhmm }] = (await queryClient`select to_char(now() at time zone ${tz}, 'HH24MI')::int as hhmm`) as unknown as [{ hhmm: number }];
    if (hhmm < 2330) expect(open.filter((r) => r.due_day === today && !r.overdue).length, "due later today").toBeGreaterThanOrEqual(3);
    expect(open.filter((r) => r.overdue).length, "overdue").toBeGreaterThanOrEqual(2);
    expect(open.filter((r) => (r.due_day as string) > today).length, "upcoming").toBeGreaterThanOrEqual(4);
    expect(open.some((r) => r.type_key === "appointment_risk")).toBe(true);
    expect(open.some((r) => r.type_key === "surgery_followup")).toBe(true);
    expect(open.filter((r) => r.type === "CALLBACK" && (r.due_day as string) > today).length, "callbacks coming up").toBeGreaterThanOrEqual(2);
  });

  it("shows the telecalling team a meaningful Command Centre, Front Desk and Leads (through the API, as staff)", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "namokar.admin@pulseos.local", password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const get = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

    const strip = (await get("/dashboard/today")).json();
    expect(strip.newEnquiries).toBeGreaterThanOrEqual(8);
    expect(strip.appointmentsToday).toBe(10);
    expect(strip.waitingNow).toBe(2); // checked in + waiting
    expect(strip.consultationsCompleted).toBe(4);
    expect(strip.attributedRevenue, "Namokar runs no revenue workflow: no figure, not a zero").toBeNull();

    const desk = (await get("/front-desk")).json();
    expect(desk.today).toHaveLength(10);
    expect(desk.noShows).toHaveLength(1);

    expect(await queryClient`select 1 from journeys where tenant_id = ${tenantId} and stage = 'lost'`).not.toHaveLength(0);
  });
});

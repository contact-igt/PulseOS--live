import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { addDays } from "../lib/hospital-time.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS DB and DEMO_PASSWORD matching the seed run.
// The Command Centre period (range / from / to) drives every period widget in the hospital's timezone; branch and
// service must narrow every widget that claims to honour them; malformed input is a 400, never a 500.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const NO_SUCH_BRANCH = "00000000-0000-4000-8000-000000000000";

describe.skipIf(!DEMO_PASSWORD)("Command Centre period + filter consistency (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let timezone: string;
  let today: string;

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

  /** Journeys created on a hospital-local day between from..to, counted straight from the table. */
  async function journeysCreated(from: string, to: string): Promise<number> {
    const rows = await queryClient`
      select count(*)::int as c from journeys
      where tenant_id = ${tenantId}
        and created_at >= (${from}::date)::timestamp at time zone ${timezone}
        and created_at < ((${to}::date + 1))::timestamp at time zone ${timezone}`;
    return rows[0]!.c as number;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const [u] = await queryClient`select u.tenant_id, t.timezone from users u join tenants t on t.id = u.tenant_id where u.email = 'gyn.admin@pulseos.local'`;
    tenantId = u!.tenant_id as string;
    timezone = (u!.timezone as string) ?? "Asia/Kolkata";
    const [d] = await queryClient`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as d`;
    today = d!.d as string;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  describe("input validation", () => {
    it.each([
      ["unknown preset", "range=bogus"],
      ["custom without dates", "range=custom"],
      ["inverted custom range", "range=custom&from=2026-09-10&to=2026-09-01"],
      ["malformed branch id", "branchId=not-a-uuid"],
    ])("rejects %s with 400", async (_name, query) => {
      for (const path of ["executive", "journey-health", "source-performance", "service-mix", "branch-doctor", "today"]) {
        const res = await get(`/dashboard/${path}?${query}`);
        expect(res.statusCode, `${path}?${query}`).toBe(400);
      }
    });

    it("rejects a custom range that ends in the future", async () => {
      const res = await get(`/dashboard/executive?range=custom&from=${today}&to=${addDays(today, 3)}`);
      expect(res.statusCode).toBe(400);
    });
  });

  describe("period", () => {
    it("executive strip echoes the resolved hospital-timezone period", async () => {
      const res = await get("/dashboard/executive?range=7d");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.period).toMatchObject({ preset: "7d", from: addDays(today, -6), to: today, days: 7, timezone });
    });

    it("executive enquiries equal journeys created in the selected hospital-local days", async () => {
      const from = addDays(today, -29);
      const res = await get(`/dashboard/executive?range=custom&from=${from}&to=${today}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().enquiries).toBe(await journeysCreated(from, today));
    });

    it("a shorter period never reports more than a longer one, and 'today' is within the last 7 days", async () => {
      const [t, w, m] = await Promise.all(["today", "7d", "30d"].map(async (r) => (await get(`/dashboard/executive?range=${r}`)).json()));
      expect(t.enquiries).toBeLessThanOrEqual(w.enquiries);
      expect(w.enquiries).toBeLessThanOrEqual(m.enquiries);
      expect(t.attributedRevenue).toBeLessThanOrEqual(w.attributedRevenue);
      expect(w.marketingSpend).toBeLessThanOrEqual(m.marketingSpend);
    });

    it("without a period the executive strip stays all-time (back-compatible)", async () => {
      const res = await get("/dashboard/executive");
      const body = res.json();
      expect(body.period ?? null).toBeNull();
      expect(body.enquiries).toBe(await journeysCreated("2000-01-01", today));
    });

    it("the journey funnel and health are a cohort of journeys created in the period", async () => {
      const from = addDays(today, -13);
      const expected = await journeysCreated(from, today);
      const health = (await get(`/dashboard/journey-health?range=custom&from=${from}&to=${today}`)).json();
      expect(health.totalJourneys).toBe(expected);
      const funnel = (await get(`/dashboard/conversion?range=custom&from=${from}&to=${today}`)).json() as { key: string; count: number }[];
      expect(funnel.find((s) => s.key === "enquiry")!.count).toBe(expected);
    });

    it("service mix covers only journeys created in the period", async () => {
      const from = addDays(today, -6);
      const rows = (await get(`/dashboard/service-mix?range=custom&from=${from}&to=${today}`)).json() as { journeys: number }[];
      expect(rows.reduce((s, r) => s + r.journeys, 0)).toBe(await journeysCreated(from, today));
    });

    it("source performance counts only touchpoints inside the period and prorates spend", async () => {
      const all = (await get("/dashboard/source-performance")).json() as { enquiries: number; spend: number }[];
      const day = (await get("/dashboard/source-performance?range=today")).json() as { enquiries: number; spend: number }[];
      expect(day.reduce((s, r) => s + r.enquiries, 0)).toBeLessThanOrEqual(all.reduce((s, r) => s + r.enquiries, 0));
      expect(day.reduce((s, r) => s + r.spend, 0)).toBeLessThan(all.reduce((s, r) => s + r.spend, 0));
    });

    it("doctor appointments and consultations follow the period (waiting load stays live)", async () => {
      const all = (await get("/dashboard/branch-doctor")).json() as { appointments: number; consultations: number }[];
      const day = (await get("/dashboard/branch-doctor?range=today")).json() as { appointments: number; consultations: number }[];
      expect(day.reduce((s, r) => s + r.appointments, 0)).toBeLessThanOrEqual(all.reduce((s, r) => s + r.appointments, 0));
      expect(day.reduce((s, r) => s + r.consultations, 0)).toBeLessThanOrEqual(all.reduce((s, r) => s + r.consultations, 0));
    });
  });

  describe("branch and service filters narrow every widget that claims to honour them", () => {
    it("a branch with no data zeroes the whole Today strip (revenue, treatment decisions, waiting included)", async () => {
      const body = (await get(`/dashboard/today?branchId=${NO_SUCH_BRANCH}`)).json();
      expect(body).toMatchObject({ newEnquiries: 0, appointmentsToday: 0, waitingNow: 0, consultationsCompleted: 0, treatmentDecisionsPending: 0, attributedRevenue: 0 });
    });

    it("a service with no data zeroes the whole Today strip", async () => {
      const body = (await get("/dashboard/today?journeyType=__no_such_service__")).json();
      expect(body).toMatchObject({ newEnquiries: 0, appointmentsToday: 0, waitingNow: 0, consultationsCompleted: 0, treatmentDecisionsPending: 0, attributedRevenue: 0 });
    });

    it("a service with no data empties the attention queue, patient flow and team load", async () => {
      expect((await get("/dashboard/attention?journeyType=__no_such_service__")).json()).toEqual([]);
      const flow = (await get("/dashboard/patient-flow?journeyType=__no_such_service__")).json() as { count: number }[];
      expect(flow.every((f) => f.count === 0)).toBe(true);
      const team = (await get("/dashboard/team?journeyType=__no_such_service__")).json() as { openTasks: number; overdueTasks: number }[];
      expect(team.every((r) => r.openTasks === 0 && r.overdueTasks === 0)).toBe(true);
    });

    it("a branch with no data zeroes doctor appointments and consultations", async () => {
      const rows = (await get(`/dashboard/branch-doctor?range=30d&branchId=${NO_SUCH_BRANCH}`)).json() as unknown[];
      expect(rows).toEqual([]);
    });
  });
});

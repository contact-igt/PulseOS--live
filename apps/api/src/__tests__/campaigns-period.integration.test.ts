import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { addDays } from "../lib/hospital-time.js";
import type { FastifyInstance } from "fastify";

// The Campaigns date filter is a hospital-calendar-day range (not UTC), is validated (400, never 500), and a
// campaign's spend is prorated over the days it ran inside the range so cost-per-lead/ROAS compare like with like.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("campaigns period (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let timezone: string;
  let today: string;

  const get = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

  async function touchpointsOn(from: string, to: string): Promise<number> {
    const rows = await queryClient`
      select count(*)::int as c from campaign_touchpoints
      where tenant_id = ${tenantId} and campaign_id is not null
        and occurred_at >= (${from}::date)::timestamp at time zone ${timezone}
        and occurred_at < ((${to}::date + 1))::timestamp at time zone ${timezone}`;
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

  it.each([
    ["a malformed date", "dateFrom=yesterday"],
    ["an impossible date", "dateFrom=2026-02-31&dateTo=2026-03-01"],
    ["an inverted range", "dateFrom=2026-09-10&dateTo=2026-09-01"],
    ["a malformed branch id", "branchId=nope"],
    ["an unknown source", "source=carrier-pigeon"],
    ["a malformed campaign id", "campaignId=nope"],
  ])("rejects %s with 400 on every campaigns endpoint", async (_n, query) => {
    for (const path of ["performance", "marketing-efficiency"]) {
      const res = await get(`/campaigns/${path}?${query}`);
      expect(res.statusCode, `${path}?${query}`).toBe(400);
    }
  });

  it("counts leads on hospital-local days, not UTC days", async () => {
    // One day at a time over the last week: UTC bounds would move the 18:30-24:00 UTC touchpoints to the wrong day.
    for (let back = 0; back < 7; back++) {
      const day = addDays(today, -back);
      const rows = (await get(`/campaigns/performance?dateFrom=${day}&dateTo=${day}`)).json() as { leads: number }[];
      expect(rows.reduce((s, r) => s + r.leads, 0), day).toBe(await touchpointsOn(day, day));
    }
  });

  it("prorates spend over the days the campaign ran inside the range", async () => {
    const all = (await get("/campaigns/performance")).json() as { spend: number }[];
    const oneDay = (await get(`/campaigns/performance?dateFrom=${today}&dateTo=${today}`)).json() as { spend: number }[];
    expect(oneDay.reduce((s, r) => s + r.spend, 0)).toBeLessThan(all.reduce((s, r) => s + r.spend, 0));
  });

  it("without dates spend is lifetime spend (unchanged)", async () => {
    const rows = (await get("/campaigns/performance")).json() as { spend: number }[];
    const [{ total }] = await queryClient`select coalesce(sum(spend_amount),0)::int as total from marketing_campaigns where tenant_id = ${tenantId}`;
    expect(rows.reduce((s, r) => s + r.spend, 0)).toBe(total);
  });
});

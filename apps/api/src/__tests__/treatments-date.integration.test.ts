import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { addDays } from "../lib/hospital-time.js";

// The Treatments table can be narrowed by an EXPLICIT date dimension: the day the procedure is scheduled for, or the day
// it was completed. Never a bare "date", and never the payment date (that is revenue, not a treatment date).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("treatments by date (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let tz: string;
  let today: string;
  const get = (q: string) => app.inject({ method: "GET", url: `/treatments${q}`, cookies: { pulseos_session: cookie } });
  const count = async (col: "planned_date" | "completed_at", from: string, to: string) =>
    (await queryClient`
      select count(*)::int as c from treatment_opportunities
      where tenant_id = ${tenantId}
        and ${queryClient.unsafe(col)} >= (${from}::date)::timestamp at time zone ${tz}
        and ${queryClient.unsafe(col)} < ((${to}::date + 1))::timestamp at time zone ${tz}`)[0]!.c as number;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    cookie = (await app.inject({ method: "POST", url: "/auth/login", payload: { email: "eye.admin@pulseos.local", password: DEMO_PASSWORD } })).cookies.find((c) => c.name === "pulseos_session")!.value;
    const [t] = await queryClient`select t.id, t.timezone from tenants t join users u on u.tenant_id = t.id where u.email = 'eye.admin@pulseos.local'`;
    tenantId = t!.id as string;
    tz = t!.timezone as string;
    today = (await queryClient`select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as d`)[0]!.d as string;
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("scheduled date: exactly the treatments planned on those hospital days", async () => {
    const from = addDays(today, -30);
    const to = addDays(today, 30);
    const rows = (await get(`?dateField=scheduled&from=${from}&to=${to}`)).json() as unknown[];
    expect(rows).toHaveLength(await count("planned_date", from, to));
    expect(rows.length).toBeGreaterThan(0);
    const all = (await get("")).json() as unknown[];
    expect(rows.length).toBeLessThan(all.length); // unplanned treatments are not "scheduled in this range"
  });

  it("completed date: exactly the treatments completed on those hospital days", async () => {
    const from = addDays(today, -60);
    const rows = (await get(`?dateField=completed&from=${from}&to=${today}`)).json() as unknown[];
    expect(rows).toHaveLength(await count("completed_at", from, today));
    expect((await get(`?dateField=completed&from=2000-01-01&to=2000-01-02`)).json()).toEqual([]);
  });

  it("the date filter combines with the other filters", async () => {
    const from = addDays(today, -60);
    const to = addDays(today, 60);
    const both = (await get(`?dateField=scheduled&from=${from}&to=${to}&status=SCHEDULED`)).json() as { status: string }[];
    expect(both.every((r) => r.status === "SCHEDULED")).toBe(true);
  });

  it.each([
    ["a dimension without dates", "?dateField=scheduled"],
    ["dates without a dimension", "?from=2026-09-01&to=2026-09-30"],
    ["an unknown dimension (payment date is revenue, not a treatment date)", "?dateField=payment&from=2026-09-01&to=2026-09-30"],
    ["half a range", "?dateField=completed&from=2026-09-01"],
    ["an inverted range", "?dateField=completed&from=2026-09-30&to=2026-09-01"],
    ["a malformed date", "?dateField=completed&from=yesterday&to=today"],
  ])("rejects %s with 400", async (_n, q) => {
    expect((await get(q)).statusCode).toBe(400);
  });
});

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { addDays } from "../lib/hospital-time.js";
import type { FastifyInstance } from "fastify";

// My Work's Completed list is a history: it takes a hospital-day window on the day the task was completed, and its tab
// count follows the same window so the badge matches the list.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("My Work completed window (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let timezone: string;
  let today: string;
  const get = (url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const [u] = await queryClient`select t.timezone from users u join tenants t on t.id = u.tenant_id where u.email = 'gyn.admin@pulseos.local'`;
    timezone = (u!.timezone as string) ?? "Asia/Kolkata";
    const [d] = await queryClient`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as d`;
    today = d!.d as string;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it.each([
    ["a malformed date", "completedFrom=x&completedTo=2026-09-01"],
    ["only a start", "completedFrom=2026-09-01"],
    ["an inverted range", "completedFrom=2026-09-10&completedTo=2026-09-01"],
  ])("rejects %s with 400 on the list and the counts", async (_n, query) => {
    expect((await get(`/tasks?view=completed&${query}`)).statusCode).toBe(400);
    expect((await get(`/tasks/counts?${query}`)).statusCode).toBe(400);
  });

  async function completedInWindow(from: string, to: string, assignedTo?: string): Promise<number> {
    const rows = await queryClient`
      select count(*)::int as c from tasks t
      where t.tenant_id = (select tenant_id from users where email = 'gyn.admin@pulseos.local') and t.status = 'completed'
        and t.completed_at >= (${from}::date)::timestamp at time zone ${timezone}
        and t.completed_at < ((${to}::date + 1))::timestamp at time zone ${timezone}
        and (${assignedTo ?? null}::uuid is null or t.assigned_to = ${assignedTo ?? null}::uuid)`;
    return rows[0]!.c as number;
  }

  it("returns exactly the tasks completed on the hospital days in the window", async () => {
    for (const [from, to] of [[today, today], [addDays(today, -1), today], [addDays(today, -2), addDays(today, -1)]] as const) {
      const rows = (await get(`/tasks?view=completed&completedFrom=${from}&completedTo=${to}`)).json() as unknown[];
      expect(rows.length, `${from}..${to}`).toBe(await completedInWindow(from, to));
    }
  });

  it("a narrower window returns fewer tasks than the whole history", async () => {
    const all = (await get("/tasks?view=completed")).json() as unknown[];
    const old = (await get(`/tasks?view=completed&completedFrom=2000-01-01&completedTo=2000-01-02`)).json() as unknown[];
    expect(old).toHaveLength(0);
    expect(all.length).toBeGreaterThan(0);
  });

  it("the tab count follows the same window as the list", async () => {
    const session = (await get("/auth/session")).json() as { user: { id: string } };
    for (const [from, to] of [[today, today], [addDays(today, -6), today]] as const) {
      const counts = (await get(`/tasks/counts?completedFrom=${from}&completedTo=${to}`)).json() as { completed: number };
      expect(counts.completed, `${from}..${to}`).toBe(await completedInWindow(from, to, session.user.id));
    }
  });

  it("without a window the completed history is unchanged", async () => {
    const all = (await get("/tasks?view=completed")).json() as unknown[];
    const [{ c }] = await queryClient`select count(*)::int as c from tasks t join users u on u.tenant_id = t.tenant_id where u.email = 'gyn.admin@pulseos.local' and t.status = 'completed'`;
    expect(all.length).toBe(c);
  });
});

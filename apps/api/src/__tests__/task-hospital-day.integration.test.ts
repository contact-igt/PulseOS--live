import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tasks } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { JourneyListRow, SessionUser, TaskRow } from "@pulseos/types";

// "Today" / "Overdue" / "Upcoming" on My Work are hospital-local days
// (tenants.timezone), never the API server's clock zone. Run with TZ=UTC to
// see the difference: an IST 02:00 task is still "today" in the hospital.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const TZ = "Asia/Kolkata";
const istDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

describe.skipIf(!DEMO_PASSWORD)("task day boundaries + reschedule validation (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let me: SessionUser;
  let journey: JourneyListRow;
  const created: string[] = [];

  const inject = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, payload, cookies: { pulseos_session: cookie } });
  async function createTask(dueAt: string) {
    const res = await inject("POST", "/tasks", { patientId: journey.patientId, journeyId: journey.id, type: "CALLBACK", dueAt, assignedTo: me.id });
    const task = res.json() as TaskRow;
    created.push(task.id);
    return task;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "eye.coordinator@pulseos.local", password: DEMO_PASSWORD } });
    cookie = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    me = res.json().user;
    journey = ((await inject("GET", "/journeys")).json() as JourneyListRow[])[0];
  });

  afterAll(async () => {
    if (created.length) await db.delete(tasks).where(inArray(tasks.id, created));
    await app.close();
    await queryClient.end();
  });

  it("a task due 02:00 IST today is in the Today view, and 23:30 IST today is not Upcoming", async () => {
    const today = istDay(new Date());
    const early = await createTask(`${today}T02:00:00+05:30`);
    const late = await createTask(`${today}T23:30:00+05:30`);
    const todayIds = ((await inject("GET", "/tasks?view=today")).json() as TaskRow[]).map((t) => t.id);
    expect(todayIds).toEqual(expect.arrayContaining([early.id, late.id]));
    const upcomingIds = ((await inject("GET", "/tasks?view=upcoming")).json() as TaskRow[]).map((t) => t.id);
    expect(upcomingIds).not.toContain(late.id);
  });

  it("the My Work Today badge (/tasks/counts) uses the same hospital day as the Today list", async () => {
    const before = (await inject("GET", "/tasks/counts")).json().today as number;
    await createTask(`${istDay(new Date())}T02:00:00+05:30`);
    expect((await inject("GET", "/tasks/counts")).json().today).toBe(before + 1);
  });

  it("rejects an unparseable due date with 400 instead of a 500", async () => {
    const task = await createTask(new Date(Date.now() + 86_400_000).toISOString());
    const res = await inject("PATCH", `/tasks/${task.id}/reschedule`, { dueAt: "not-a-date" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_due_at");
  });

  it("refuses to reschedule a completed task (409)", async () => {
    const task = await createTask(new Date(Date.now() + 86_400_000).toISOString());
    expect((await inject("PATCH", `/tasks/${task.id}/complete`)).statusCode).toBe(200);
    const res = await inject("PATCH", `/tasks/${task.id}/reschedule`, { dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_completed");
  });
});

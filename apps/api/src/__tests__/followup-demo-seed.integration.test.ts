import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { appointments, followUpTypes, journeys, tasks } from "../db/schema.js";
import { awayFromHospitalMidnight, FRESH_DEMO_HOOK_TIMEOUT, freshOphthalmologyDemo } from "./helpers/fresh-demo.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Built fresh at the start of this file by the seed's own builders, so "today" here is the server's today - whenever
// the database was seeded and whatever the time zone of the machine running the suite.
describe.skipIf(!DEMO_PASSWORD)("Ophthalmology demo follow-up data (seed guarantees)", () => {
  const tenantIds = new Map<string, string>();
  beforeAll(async () => {
    await awayFromHospitalMidnight();
    for (const base of ["V1", "V2"] as const) tenantIds.set(base, (await freshOphthalmologyDemo(DEMO_PASSWORD!, base)).tenantId);
  }, FRESH_DEMO_HOOK_TIMEOUT);
  afterAll(() => queryClient.end());

  for (const [base, name] of [["V1", "PulseOS Ophthalmology V1 Demo"], ["V2", "PulseOS Ophthalmology Demo"]] as const) {
    it(`${name}: shows an overdue callback, an appointment follow-up today, an appointment risk, an upcoming surgery follow-up, a journey with none, and a booked appointment`, async () => {
      const tenantId = tenantIds.get(base)!;
      const typeKeys = new Map((await db.select().from(followUpTypes).where(eq(followUpTypes.tenantId, tenantId))).map((t) => [t.id, t.key]));
      const open = (await db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.status, ["pending", "in_progress"])))).map((t) => ({ ...t, key: t.followUpTypeId ? typeKeys.get(t.followUpTypeId) : null }));
      const now = Date.now();

      expect(open.some((t) => t.type === "CALLBACK" && t.dueAt.getTime() < now)).toBe(true);
      const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      expect(open.some((t) => t.key === "appointment_followup" && t.dueAt.getTime() > now && t.dueAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === todayKey)).toBe(true);
      expect(open.some((t) => t.key === "appointment_risk" && t.priority === "high" && t.notes)).toBe(true);
      expect(open.some((t) => t.key === "surgery_followup" && t.dueAt.getTime() > now + 24 * 3_600_000)).toBe(true);

      const withOpenTask = new Set(open.map((t) => t.journeyId));
      const active = await db.select().from(journeys).where(eq(journeys.tenantId, tenantId));
      expect(active.some((j) => !["completed", "lost"].includes(j.stage) && !withOpenTask.has(j.id) && j.journeyType === "General Eye Consultation")).toBe(true);
      expect((await db.select().from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.status, "scheduled")))).some((a) => a.scheduledAt.getTime() > now)).toBe(true);
    });
  }
});

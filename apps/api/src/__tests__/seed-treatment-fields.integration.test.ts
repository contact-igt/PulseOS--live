import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";

// The demo tenants are built through the same fields the real transitions write, so what they show is what a real
// hospital gets: a scheduled procedure says when, with whom and where; a completed one says when it was completed.
describe("demo treatments carry the operational fields the model requires", () => {
  afterAll(async () => {
    await queryClient.end();
  });

  it("the demo tenants are seeded with scheduled and completed procedures (so the checks below are not vacuous)", async () => {
    const rows = await db.execute<{ s: string; c: number }>(sql`select t.status as s, count(*)::int as c from treatment_opportunities t join tenants n on n.id = t.tenant_id where n.name like 'PulseOS%' and t.status in ('SCHEDULED','COMPLETED') group by 1`);
    const by = Object.fromEntries([...rows].map((r) => [r.s, r.c]));
    expect(by.SCHEDULED ?? 0).toBeGreaterThan(0);
    expect(by.COMPLETED ?? 0).toBeGreaterThan(0);
  });

  it("every SCHEDULED demo procedure has a planned date, a doctor and a branch", async () => {
    const rows = await db.execute<{ n: string; label: string }>(sql`
      select n.name as n, t.treatment_label as label
      from treatment_opportunities t join tenants n on n.id = t.tenant_id
      where n.name like 'PulseOS%' and t.status = 'SCHEDULED' and (t.planned_date is null or t.scheduled_resource_id is null or t.scheduled_branch_id is null)`);
    expect([...rows]).toEqual([]);
  });

  it("every COMPLETED demo treatment has a completion time, and nothing else carries one", async () => {
    const missing = await db.execute<{ c: number }>(sql`select count(*)::int as c from treatment_opportunities t join tenants n on n.id = t.tenant_id where n.name like 'PulseOS%' and t.status = 'COMPLETED' and t.completed_at is null`);
    expect([...missing][0]!.c).toBe(0);
    const stray = await db.execute<{ c: number }>(sql`select count(*)::int as c from treatment_opportunities where status <> 'COMPLETED' and completed_at is not null`);
    expect([...stray][0]!.c).toBe(0);
  });
});

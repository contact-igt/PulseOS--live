import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded PulseOS dev DB
// (the same one `pnpm db:seed` populates, with the deterministic marketing story), and
// DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("marketing → patient journey dashboard (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("executive strip reflects the seeded campaign spend, revenue, and ROAS", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // marketingSpend cross-checked against a live sum over every campaign this tenant
    // currently has, rather than a hardcoded seed-time constant: campaign-sync.integration.test.ts
    // (deliberately, per its own header comment) leaves fixture campaigns it syncs in place
    // rather than cleaning them up, since deleting them would violate campaign_touchpoints'
    // FK from other tests' data. That's real, desired persistence — not something to
    // suppress — so this assertion stays correct regardless of suite run order or which
    // other tests have synced additional campaigns before this one runs.
    const performance = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: cookie } });
    const liveSpend = (performance.json() as { spend: number }[]).reduce((sum, r) => sum + r.spend, 0);
    expect(body.marketingSpend).toBe(liveSpend);
    // Includes the seeded "Meta – Antenatal Care Awareness" campaign (₹18,000, deliberately
    // low-converting — see seed.ts) added to demonstrate Campaigns-page budget leakage.
    // attributedRevenue is a live tenant-wide sum, not a fixed seed-time constant: completing
    // a treatment now writes a real revenue_events row (the production write path this
    // checkpoint added — see treatment.service.ts's updateTreatmentStatus), so other suites
    // in this shared dev DB that complete treatments (e.g. post-care.integration.test.ts,
    // treatment-revenue-event.integration.test.ts) legitimately add to this total. That's
    // real, desired behavior — not something to suppress — so this only asserts the seeded
    // floor rather than an exact seed-time number, keeping it correct regardless of suite
    // run order or how much other revenue has been recorded elsewhere in the run.
    expect(body.attributedRevenue).toBeGreaterThanOrEqual(22_000 + 95_000 + 110_000 + 88_000);
    // treatmentsCompleted is a live tenant-wide count, not a seed-time constant: other
    // suites in this shared dev DB (e.g. post-care.integration.test.ts) legitimately
    // complete additional treatments as part of what they're testing, and that's real,
    // desired behavior — not something to suppress. Cross-checking against the same
    // live count the /treatments endpoint reports (rather than a hardcoded seed number)
    // keeps this assertion correct regardless of suite run order or how many other
    // treatments have been completed elsewhere in the run.
    const completedTreatments = await app.inject({ method: "GET", url: "/treatments?status=COMPLETED", cookies: { pulseos_session: cookie } });
    expect(body.treatmentsCompleted).toBe((completedTreatments.json() as unknown[]).length);
    expect(body.roas).toBeCloseTo(body.attributedRevenue / body.marketingSpend, 5);
  });

  it("source performance never divides by zero and orders by spend descending", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/source-performance", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { spend: number; revenue: number; roas: number | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].spend).toBeLessThanOrEqual(rows[i - 1].spend);
    }
    const websiteRow = rows.find((r: unknown) => (r as { campaignName: string }).campaignName === "Website – Landing Page")!;
    expect(websiteRow.revenue).toBe(0);
    expect(websiteRow.roas).toBe(0); // zero revenue with real spend is 0, never null/NaN
  });

  it("Meta campaign shows cheap acquisition but poor treatment conversion vs. Google", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/source-performance", cookies: { pulseos_session: cookie } });
    const rows = res.json() as { campaignName: string; spend: number; enquiries: number; treatments: number; roas: number | null }[];
    const meta = rows.find((r) => r.campaignName === "Meta – Fertility Awareness")!;
    const google = rows.find((r) => r.campaignName.startsWith("Google"))!;
    expect(meta.spend / meta.enquiries).toBeLessThan(google.spend / google.enquiries);
    expect(meta.roas!).toBeLessThan(google.roas!);
  });

  it("spend at risk totals the sum of its own categories and never counts unattributed journeys", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/spend-at-risk", cookies: { pulseos_session: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; categories: { allocatedSpend: number; journeyCount: number }[] };
    const sum = body.categories.reduce((s, c) => s + c.allocatedSpend, 0);
    expect(body.total).toBe(sum);
    expect(body.categories.every((c) => c.journeyCount >= 0)).toBe(true);
  });

  it("tenant isolation: a request with no session cannot read marketing data", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/executive" });
    expect(res.statusCode).toBe(401);
  });
});

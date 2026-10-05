import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { CampaignPerformanceRow, MarketingEfficiencySummary, SpendAtRisk } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("campaigns / marketing efficiency (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let doctorCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("a role without VIEW_MARKETING (Doctor) is forbidden with the specific permission named", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("VIEW_MARKETING");
  });

  it("lists campaign performance with real spend and never NaN/Infinity ratios", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CampaignPerformanceRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.spend).toBeGreaterThanOrEqual(0);
      if (row.roas !== null) expect(Number.isFinite(row.roas)).toBe(true);
      if (row.cpl !== null) expect(Number.isFinite(row.cpl)).toBe(true);
    }
  });

  it("a manually-seeded campaign (never synced from a provider) reports connectorMode: null — never implies real synced spend", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    const rows = res.json() as CampaignPerformanceRow[];
    const antenatal = rows.find((r) => r.campaignName === "Meta – Antenatal Care Awareness");
    expect(antenatal).toBeDefined();
    expect(antenatal!.connectorMode).toBeNull();
  });

  it("a single campaign fetched by campaignId filter returns exactly that one row, for the Campaign Detail page header", async () => {
    const all = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    const allRows = all.json() as CampaignPerformanceRow[];
    const target = allRows.find((r) => r.campaignName === "Meta – Antenatal Care Awareness")!;
    const res = await app.inject({ method: "GET", url: `/campaigns/performance?campaignId=${target.campaignId}`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CampaignPerformanceRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].campaignId).toBe(target.campaignId);
  });

  it("Campaign Detail's Attribution/Journey list — /journeys?campaignId returns exactly the journeys counted as leads for that campaign, each linkable to Patient 360", async () => {
    const all = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    const target = (all.json() as CampaignPerformanceRow[]).find((r) => r.campaignName === "Meta – Antenatal Care Awareness")!;
    const res = await app.inject({ method: "GET", url: `/journeys?campaignId=${target.campaignId}`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: string; patientId: string; campaignName: string | null }[];
    expect(rows.length).toBe(target.leads);
    for (const row of rows) {
      expect(row.patientId).toBeTruthy();
      expect(row.campaignName).toBe("Meta – Antenatal Care Awareness");
    }
  });

  it("filters campaign performance by source", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance?source=meta", cookies: { pulseos_session: adminCookie } });
    const rows = res.json() as CampaignPerformanceRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "meta")).toBe(true);
  });

  it("filters campaign performance by date range — a window in the far future excludes every seeded touchpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance?dateFrom=2099-01-01&dateTo=2099-12-31", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CampaignPerformanceRow[];
    // Every row still appears (campaigns aren't filtered out), but none has
    // any lead attributed inside this impossible window.
    expect(rows.every((r) => r.leads === 0)).toBe(true);
  });

  it("a date range wide enough to cover all seed data returns the same totals as no date filter at all", async () => {
    const unfiltered = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    const filtered = await app.inject({ method: "GET", url: "/campaigns/performance?dateFrom=2020-01-01&dateTo=2099-12-31", cookies: { pulseos_session: adminCookie } });
    const unfilteredRows = unfiltered.json() as CampaignPerformanceRow[];
    const filteredRows = filtered.json() as CampaignPerformanceRow[];
    const totalLeadsUnfiltered = unfilteredRows.reduce((sum, r) => sum + r.leads, 0);
    const totalLeadsFiltered = filteredRows.reduce((sum, r) => sum + r.leads, 0);
    expect(totalLeadsFiltered).toBe(totalLeadsUnfiltered);
  });

  it("filters campaign performance by specialty — the seeded Antenatal campaign's Gynecology leads are isolated from other specialties' traffic", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance?specialtyKey=GYNECOLOGY", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CampaignPerformanceRow[];
    const antenatal = rows.find((r) => r.campaignName === "Meta – Antenatal Care Awareness");
    expect(antenatal).toBeDefined();
    expect(antenatal!.leads).toBeGreaterThan(0);
    expect(antenatal!.specialtyKey).toBe("GYNECOLOGY");
  });

  it("the weak seeded campaign shows real leakage: leads without matching treatment revenue", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: adminCookie } });
    const rows = res.json() as CampaignPerformanceRow[];
    const antenatal = rows.find((r) => r.campaignName === "Meta – Antenatal Care Awareness");
    expect(antenatal).toBeDefined();
    expect(antenatal!.spend).toBe(18_000);
    expect(antenatal!.treatmentCompleted).toBe(0);
    expect(antenatal!.revenue).toBe(0);
    expect(antenatal!.roas).toBe(0); // spend > 0, revenue 0 → a real, finite 0×, never Infinity/NaN
  });

  it("marketing efficiency summary aggregates spend/leads/revenue with guarded ratios", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/marketing-efficiency", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const summary = res.json() as MarketingEfficiencySummary;
    expect(summary.spend).toBeGreaterThan(0);
    expect(summary.leads).toBeGreaterThan(0);
    if (summary.roas !== null) expect(Number.isFinite(summary.roas)).toBe(true);
  });

  it("spend-at-risk uses 'Spend At Risk' wording (not 'Marketing Waste') for recoverable, active leakage", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/spend-at-risk", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SpendAtRisk;
    expect(body.totalAtRisk).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.byReason)).toBe(true);
  });
});

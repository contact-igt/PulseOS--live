import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { marketingCampaigns, tenants } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CampaignViewRow } from "@pulseos/types";

// Campaigns Calendar / Timeline views read the campaign's run window from the
// same /campaigns/performance rows the table uses (one query, three views).
// endDate is nullable in the schema: null means the campaign is ONGOING and the
// API must pass that through as null — never invent an end date.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const MARKER = `P3 view test ${Date.now()}`;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("campaign views — run window on performance rows (integration)", () => {
  let app: FastifyInstance;
  let eyeAdmin: string;
  let gynAdmin: string;
  const createdIds: string[] = [];
  let endedId = "";
  let ongoingId = "";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    eyeAdmin = await loginAs(app, "eye.admin@pulseos.local");
    gynAdmin = await loginAs(app, "gyn.admin@pulseos.local");
    const [eye] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Ophthalmology Demo"));
    const [ended] = await db
      .insert(marketingCampaigns)
      .values({ tenantId: eye.id, source: "google", name: `${MARKER} ended`, spendAmount: 1000, startDate: new Date("2026-07-01T04:30:00.000Z"), endDate: new Date("2026-07-31T12:30:00.000Z"), status: "ended" })
      .returning();
    const [ongoing] = await db
      .insert(marketingCampaigns)
      .values({ tenantId: eye.id, source: "meta", name: `${MARKER} ongoing`, spendAmount: 500, startDate: new Date("2026-09-15T04:30:00.000Z"), endDate: null, status: "active" })
      .returning();
    endedId = ended.id;
    ongoingId = ongoing.id;
    createdIds.push(ended.id, ongoing.id);
  });

  afterAll(async () => {
    if (createdIds.length) await db.delete(marketingCampaigns).where(inArray(marketingCampaigns.id, createdIds));
    await app.close();
    await queryClient.end();
  });

  it("every row carries its campaign id, ISO startDate, endDate (or null) and run status", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: eyeAdmin } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CampaignViewRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.campaignId).toBe("string");
      expect(Number.isFinite(Date.parse(row.startDate))).toBe(true);
      expect(row.endDate === null || Number.isFinite(Date.parse(row.endDate))).toBe(true);
      expect(["active", "paused", "ended"]).toContain(row.campaignStatus);
    }
  });

  it("an ended campaign returns its real end date; an ongoing one returns endDate null (never a fabricated end)", async () => {
    const res = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: eyeAdmin } });
    const rows = res.json() as CampaignViewRow[];
    const ended = rows.find((r) => r.campaignId === endedId)!;
    const ongoing = rows.find((r) => r.campaignId === ongoingId)!;
    expect(ended).toMatchObject({ startDate: "2026-07-01T04:30:00.000Z", endDate: "2026-07-31T12:30:00.000Z", campaignStatus: "ended" });
    expect(ongoing).toMatchObject({ startDate: "2026-09-15T04:30:00.000Z", endDate: null, campaignStatus: "active" });
  });

  it("the run window rides on the same filtered rows (source filter), and never leaks across tenants", async () => {
    const google = await app.inject({ method: "GET", url: "/campaigns/performance?source=google", cookies: { pulseos_session: eyeAdmin } });
    const googleRows = google.json() as CampaignViewRow[];
    expect(googleRows.some((r) => r.campaignId === endedId)).toBe(true);
    expect(googleRows.some((r) => r.campaignId === ongoingId)).toBe(false);
    expect(googleRows.every((r) => r.source === "google")).toBe(true);

    const gyn = await app.inject({ method: "GET", url: "/campaigns/performance", cookies: { pulseos_session: gynAdmin } });
    const gynRows = gyn.json() as CampaignViewRow[];
    expect(gynRows.some((r) => createdIds.includes(r.campaignId))).toBe(false);
  });
});

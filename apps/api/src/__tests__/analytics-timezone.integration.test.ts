import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, journeys, marketingCampaigns, patients, revenueEvents, tenants } from "../db/schema.js";
import { getAnalyticsCampaigns, getAnalyticsRevenue, getAnalyticsSummary, getLeadsBySource, resolvePeriod } from "../domain/analytics/analytics.service.js";

// Day boundaries. Every analytics bucket is a calendar day in the HOSPITAL's
// timezone (tenants.timezone), not UTC and not the server clock. Each case
// below is built so the UTC date and the local date DIFFER — a UTC (or
// server-clock) grouping would put the row on the wrong day.
//
// Scratch tenants only; the demo tenants are never touched.

const DATES = "2025-03";

describe("analytics day boundaries follow the tenant timezone (integration)", () => {
  const created: { tenantIds: string[] } = { tenantIds: [] };
  let ist: string;
  let la: string;
  let istPatient: string;

  async function makeTenant(name: string, timezone: string) {
    const [t] = await db.insert(tenants).values({ name, timezone }).returning();
    created.tenantIds.push(t.id);
    const [p] = await db.insert(patients).values({ tenantId: t.id, name: "Scratch Patient", phone: "+910000000000" }).returning();
    return { tenantId: t.id, patientId: p.id };
  }

  async function addJourney(tenantId: string, patientId: string, createdAt: string, extra: Partial<typeof journeys.$inferInsert> = {}) {
    const [j] = await db
      .insert(journeys)
      .values({ tenantId, patientId, journeyType: "Cataract", source: "meta", createdAt: new Date(createdAt), ...extra })
      .returning();
    return j;
  }

  beforeAll(async () => {
    const a = await makeTenant("TZ Scratch IST", "Asia/Kolkata");
    const b = await makeTenant("TZ Scratch LA", "America/Los_Angeles");
    ist = a.tenantId;
    istPatient = a.patientId;
    la = b.tenantId;

    // IST = UTC+5:30. 18:30Z is exactly local midnight.
    await addJourney(a.tenantId, a.patientId, "2025-03-10T18:29:59Z"); // 23:59:59 IST on 10th (UTC: 10th)
    await addJourney(a.tenantId, a.patientId, "2025-03-10T18:30:00Z"); // 00:00:00 IST on 11th (UTC: 10th)  <- differs
    await addJourney(a.tenantId, a.patientId, "2025-03-10T20:00:00Z", { source: "google" }); // 01:30 IST on 11th (UTC: 10th) <- differs
    await addJourney(a.tenantId, a.patientId, "2025-03-11T18:29:59Z"); // 23:59:59 IST on 11th (UTC: 11th)
    await addJourney(a.tenantId, a.patientId, "2025-03-11T18:30:00Z"); // 00:00 IST on 12th

    // Los Angeles observes PDT (UTC-7) from 9 March 2025.
    await addJourney(b.tenantId, b.patientId, "2025-03-11T02:00:00Z"); // 19:00 on 10th (UTC: 11th)  <- differs
    await addJourney(b.tenantId, b.patientId, "2025-03-11T06:59:59Z"); // 23:59:59 on 10th (UTC: 11th)  <- differs
    await addJourney(b.tenantId, b.patientId, "2025-03-11T07:00:00Z"); // 00:00 on 11th
  });

  afterAll(async () => {
    const ids = created.tenantIds;
    if (ids.length) {
      await db.delete(revenueEvents).where(inArray(revenueEvents.tenantId, ids));
      await db.delete(campaignTouchpoints).where(inArray(campaignTouchpoints.tenantId, ids));
      await db.delete(journeys).where(inArray(journeys.tenantId, ids));
      await db.delete(marketingCampaigns).where(inArray(marketingCampaigns.tenantId, ids));
      await db.delete(patients).where(inArray(patients.tenantId, ids));
      await db.delete(tenants).where(inArray(tenants.id, ids));
    }
    await queryClient.end();
  });

  const range = (from: string, to: string) => ({ range: "custom" as const, from, to });

  it("defaults a new tenant to Asia/Kolkata", async () => {
    const [t] = await db.insert(tenants).values({ name: "TZ Scratch default" }).returning();
    created.tenantIds.push(t.id);
    expect(t.timezone).toBe("Asia/Kolkata");
  });

  it("puts an IST 00:00 enquiry (still the 10th in UTC) on the 11th", async () => {
    const res = await getLeadsBySource(db, ist, range(`${DATES}-10`, `${DATES}-12`));
    const byDay = Object.fromEntries(res.buckets.map((b) => [b.key, b.total]));
    expect(byDay).toEqual({ [`${DATES}-10`]: 1, [`${DATES}-11`]: 3, [`${DATES}-12`]: 1 });
    expect(res.period.timezone).toBe("Asia/Kolkata");
    // Source split follows the same local day.
    expect(res.buckets.find((b) => b.key === `${DATES}-11`)!.bySource).toEqual({ meta: 2, google: 1 });
  });

  it("a single-day range covers exactly the local day, not the UTC day", async () => {
    const res = await getLeadsBySource(db, ist, range(`${DATES}-11`, `${DATES}-11`));
    expect(res.total).toBe(3);
    expect(res.buckets).toHaveLength(1);
  });

  it("uses the tenant's own zone: Los Angeles rows land on the earlier local day", async () => {
    const res = await getLeadsBySource(db, la, range(`${DATES}-10`, `${DATES}-11`));
    const byDay = Object.fromEntries(res.buckets.map((b) => [b.key, b.total]));
    expect(byDay).toEqual({ [`${DATES}-10`]: 2, [`${DATES}-11`]: 1 });
    expect(res.period.timezone).toBe("America/Los_Angeles");
  });

  it("resolves 'today' per tenant timezone: the same instant is a different local day", async () => {
    const instant = new Date("2025-03-10T19:00:00Z"); // 00:30 on 11th in IST, 12:00 on 10th in LA
    const inIst = await resolvePeriod(db, ist, { range: "7d" }, instant);
    const inLa = await resolvePeriod(db, la, { range: "7d" }, instant);
    expect(inIst.to).toBe("2025-03-11");
    expect(inIst.from).toBe("2025-03-05");
    expect(inLa.to).toBe("2025-03-10");
    expect(inLa.from).toBe("2025-03-04");
    expect(inIst.days).toBe(7);
    // Previous period is the 7 days immediately before.
    expect(inIst.previousTo).toBe("2025-03-04");
    expect(inIst.previousFrom).toBe("2025-02-26");
  });

  it("reports the tenant-local 'today' so charts can mark the still-running day", async () => {
    const instant = new Date("2025-03-10T19:00:00Z");
    expect((await resolvePeriod(db, ist, { range: "7d" }, instant)).today).toBe("2025-03-11");
    expect((await resolvePeriod(db, la, { range: "7d" }, instant)).today).toBe("2025-03-10");
    // A custom range in the past still reports the real today (it is simply outside the range).
    expect((await resolvePeriod(db, ist, { range: "custom", from: "2025-01-01", to: "2025-01-31" }, instant)).today).toBe("2025-03-11");
  });

  it("week buckets are 7-day blocks anchored at the period start and cover every day once", async () => {
    const res = await getLeadsBySource(db, ist, range("2025-02-15", "2025-03-25")); // 39 days -> weekly
    expect(res.granularity).toBe("week");
    expect(res.buckets[0].key).toBe("2025-02-15");
    expect(res.buckets[1].key).toBe("2025-02-22");
    expect(res.buckets.reduce((s, b) => s + b.days, 0)).toBe(39);
    const last = res.buckets[res.buckets.length - 1];
    expect(last.partial).toBe(true); // 39 = 5 * 7 + 4
    expect(last.days).toBe(4);
    expect(last.to).toBe("2025-03-25");
    expect(res.total).toBe(5);
    // 10th and 11th/12th land in the block starting 2025-03-08 (8..14).
    expect(res.buckets.find((b) => b.key === "2025-03-08")!.total).toBe(5);
  });

  it("previous-period totals are offset-aligned with the current buckets", async () => {
    // Current 11..12 (2 days); previous is 9..10. IST: 10th holds 1 journey.
    const res = await getLeadsBySource(db, ist, range(`${DATES}-11`, `${DATES}-12`));
    expect(res.previousTotal).toBe(1);
    expect(res.buckets.map((b) => b.previousTotal)).toEqual([0, 1]); // 9th -> 0, 10th -> 1
    expect(res.total).toBe(4);
  });

  it("revenue is bucketed on the local day of occurredAt", async () => {
    const t = await db.select().from(journeys).where(eq(journeys.tenantId, ist)).limit(1);
    const j = t[0];
    await db.insert(revenueEvents).values([
      { tenantId: ist, patientId: j.patientId, journeyId: j.id, amount: 1000, occurredAt: new Date("2025-03-10T18:29:59Z") }, // 10th IST
      { tenantId: ist, patientId: j.patientId, journeyId: j.id, amount: 2000, occurredAt: new Date("2025-03-10T18:30:00Z") }, // 11th IST (UTC 10th)
    ]);
    const res = await getAnalyticsRevenue(db, ist, range(`${DATES}-10`, `${DATES}-11`));
    expect(res.granularity).toBe("day");
    expect(res.buckets.map((b) => [b.key, b.revenue])).toEqual([[`${DATES}-10`, 1000], [`${DATES}-11`, 2000]]);
    expect(res.total).toBe(3000);
  });

  it("pro-rates campaign spend by the days a campaign ran inside the period (local days)", async () => {
    const [c] = await db
      .insert(marketingCampaigns)
      .values({ tenantId: ist, source: "meta", name: "Scratch campaign", spendAmount: 3000, startDate: new Date("2025-02-28T18:30:00Z"), endDate: new Date("2025-03-30T10:00:00Z") })
      .returning(); // local run: 2025-03-01 .. 2025-03-30 = 30 days
    const res = await getAnalyticsCampaigns(db, ist, range("2025-03-01", "2025-03-10"));
    const row = res.rows.find((r) => r.campaignId === c.id)!;
    expect(row.spend).toBe(1000); // 10 / 30 of 3000
    const outside = await getAnalyticsCampaigns(db, ist, range("2025-04-01", "2025-04-10"));
    expect(outside.rows.find((r) => r.campaignId === c.id)?.spend ?? 0).toBe(0);
  });

  it("a sliced view keeps a campaign's spend when it had no enquiries in the period (lifetime enquiry mix), so slices add up", async () => {
    const [c] = await db
      .insert(marketingCampaigns)
      .values({ tenantId: ist, source: "google", name: "Slice campaign", spendAmount: 1000, startDate: new Date("2025-04-30T18:30:00Z"), endDate: new Date("2025-05-10T10:00:00Z") })
      .returning(); // local run: 2025-05-01 .. 2025-05-10
    // Its enquiries arrived before the period: one Cataract, one LASIK.
    for (const service of ["Cataract", "LASIK"]) {
      const j = await addJourney(ist, istPatient, "2025-04-20T06:00:00Z", { journeyType: service, source: "google" });
      await db.insert(campaignTouchpoints).values({ tenantId: ist, patientId: istPatient, journeyId: j.id, campaignId: c.id, source: "google", touchType: "first_touch", occurredAt: j.createdAt });
    }
    const q = { ...range("2025-05-01", "2025-05-10"), source: "google" as const };
    const whole = (await getAnalyticsSummary(db, ist, q)).spend;
    const cataract = (await getAnalyticsSummary(db, ist, { ...q, service: "Cataract" })).spend;
    const lasik = (await getAnalyticsSummary(db, ist, { ...q, service: "LASIK" })).spend;
    expect(whole).toBe(1000);
    expect(cataract).toBe(500);
    expect(cataract + lasik).toBe(whole);
  });

  it("a range ending today is compared with the previous period only up to the same elapsed point", async () => {
    const now = new Date("2025-03-11T04:30:00Z"); // 10:00 IST on the 11th; 7D = 5..11 Mar, previous = 26 Feb..4 Mar
    const prevTotal = async () => (await getLeadsBySource(db, ist, { range: "7d" }, now)).previousTotal;
    const before = await prevTotal();
    await addJourney(ist, istPatient, "2025-03-04T03:30:00Z"); // 09:00 IST on 4 Mar — before the elapsed point
    await addJourney(ist, istPatient, "2025-03-04T06:30:00Z"); // 12:00 IST on 4 Mar — after it (today has not reached 12:00 yet)
    expect(await prevTotal()).toBe(before + 1);
  });

  it("rejects a custom range that ends in the future (it would be compared with a full previous period)", async () => {
    await expect(resolvePeriod(db, ist, { range: "custom", from: "2025-03-01", to: "2025-03-20" }, new Date("2025-03-11T04:30:00Z"))).rejects.toThrow(/future/i);
  });

  it("rejects an inverted or oversized custom range", async () => {
    await expect(resolvePeriod(db, ist, { range: "custom", from: "2025-03-12", to: "2025-03-10" })).rejects.toThrow(/range/i);
    await expect(resolvePeriod(db, ist, { range: "custom", from: "2020-01-01", to: "2025-03-10" })).rejects.toThrow(/range/i);
  });
});

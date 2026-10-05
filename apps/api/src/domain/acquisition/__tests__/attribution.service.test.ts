import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db, queryClient } from "../../../db/client.js";
import { eq } from "drizzle-orm";
import { campaignTouchpoints, journeys, patients, tenants } from "../../../db/schema.js";
import { getAttributionSummary, recordTouchpoint } from "../attribution.service.js";

describe("attribution.service (recordTouchpoint / getAttributionSummary)", () => {
  let tenantId: string;
  let patientId: string;
  let journeyId: string;

  beforeAll(async () => {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
    tenantId = tenant.id;

    const [patient] = await db
      .insert(patients)
      .values({ tenantId, name: "Attribution Test Patient", phone: `9${Math.floor(100000000 + Math.random() * 899999999)}` })
      .returning({ id: patients.id });
    patientId = patient.id;

    const [journey] = await db
      .insert(journeys)
      .values({ tenantId, patientId, journeyType: "Attribution Test", source: "meta" })
      .returning({ id: journeys.id });
    journeyId = journey.id;
  });

  afterAll(async () => {
    // This test borrows whatever tenant comes first (which can be a demo or pilot workspace): leave nothing behind in it.
    await db.delete(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, journeyId));
    await db.delete(journeys).where(eq(journeys.id, journeyId));
    await db.delete(patients).where(eq(patients.id, patientId));
    await queryClient.end();
  });

  it("the first recorded touchpoint for a journey is first_touch", async () => {
    const result = await recordTouchpoint(db, {
      tenantId,
      patientId,
      journeyId,
      details: { source: "meta", occurredAt: new Date("2026-09-01T10:00:00Z"), utmCampaign: "Meta – Fertility Awareness" },
    });
    expect(result.touchType).toBe("first_touch");
  });

  it("a second touchpoint on the same journey becomes last_touch and does not overwrite first_touch", async () => {
    const result = await recordTouchpoint(db, {
      tenantId,
      patientId,
      journeyId,
      details: { source: "google", occurredAt: new Date("2026-09-05T10:00:00Z"), utmCampaign: "Google – IVF Search" },
    });
    expect(result.touchType).toBe("last_touch");

    const summary = await getAttributionSummary(db, journeyId);
    expect(summary.firstTouch?.source).toBe("meta");
    expect(summary.currentLastTouch?.source).toBe("google");
    expect(summary.history).toHaveLength(2);
    expect(summary.history.map((t) => t.source)).toEqual(["meta", "google"]);
  });

  it("a third touchpoint updates the current last touch while history keeps every touch and first touch is still immutable", async () => {
    await recordTouchpoint(db, {
      tenantId,
      patientId,
      journeyId,
      details: { source: "website", occurredAt: new Date("2026-09-08T10:00:00Z") },
    });

    const summary = await getAttributionSummary(db, journeyId);
    expect(summary.firstTouch?.source).toBe("meta");
    expect(summary.currentLastTouch?.source).toBe("website");
    expect(summary.history).toHaveLength(3);
  });
});

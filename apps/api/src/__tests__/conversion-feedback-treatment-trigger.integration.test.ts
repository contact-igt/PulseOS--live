import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, conversionFeedbackEvents, journeys, patients, revenueEvents, tasks, tenants, treatmentOpportunities, timelineEvents, users } from "../db/schema.js";
import { updateTreatmentStatus } from "../domain/treatment/treatment.service.js";
import { recordTouchpoint } from "../domain/acquisition/attribution.service.js";
import { googleAdsLeadFormsAdapter } from "../domain/acquisition/adapters/google-ads-lead-forms.js";
import type { ConversionFeedbackPayload } from "../domain/acquisition/types.js";
import type { NormalizedLead } from "../domain/acquisition/types.js";

// Integration test: requires DATABASE_URL pointed at a migrated + SEEDED
// PulseOS dev DB (needs a real user row for actorId). This proves the
// concrete scenario the checkpoint describes: a Journey reaching Treatment
// Completed makes a conversion-feedback event eligible, and a fixture
// payload can be built from it exactly once per journey.

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("Treatment Completed -> conversion feedback eligibility — integration", () => {
  let tenantId: string;
  let actorId: string;
  let patientId: string;
  let journeyId: string;
  let treatmentAId: string;
  let treatmentBId: string;

  beforeAll(async () => {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo")).limit(1);
    tenantId = tenant.id;
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId)).limit(1);
    actorId = user.id;

    const [patient] = await db.insert(patients).values({ tenantId, name: "Treatment Trigger Test Patient", phone: "+919876500055", marketingConsent: true }).returning();
    patientId = patient.id;
    const [journey] = await db.insert(journeys).values({ tenantId, patientId, journeyType: "Treatment Trigger Test", source: "google", stage: "treatment_advised" }).returning();
    journeyId = journey.id;

    const lead: NormalizedLead = {
      externalLeadId: `lead-treatment-trigger-${Date.now()}`, externalFormId: null, externalAccountId: null,
      externalCampaignId: "CAMPAIGN_TREATMENT_TRIGGER", externalAdGroupId: null, externalAdId: null,
      name: patient.name, phone: patient.phone, email: null, source: "google", medium: "cpc",
      utmCampaign: null, utmContent: null, utmTerm: null,
      gclid: "gclid-treatment-trigger-test", gbraid: null, wbraid: null, fbclid: null,
      occurredAt: new Date(), metadata: {},
    };
    await recordTouchpoint(db, { tenantId, patientId, journeyId, details: lead, campaignName: "Treatment Trigger Campaign" });

    const [treatmentA] = await db.insert(treatmentOpportunities).values({ tenantId, patientId, journeyId, treatmentLabel: "IVF Cycle 1", status: "SCHEDULED", estimatedValue: 120000 }).returning();
    treatmentAId = treatmentA.id;
    const [treatmentB] = await db.insert(treatmentOpportunities).values({ tenantId, patientId, journeyId, treatmentLabel: "IVF Cycle 2", status: "SCHEDULED", estimatedValue: 95000 }).returning();
    treatmentBId = treatmentB.id;
  });

  afterAll(async () => {
    await db.delete(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, journeyId));
    await db.delete(tasks).where(eq(tasks.journeyId, journeyId));
    await db.delete(timelineEvents).where(eq(timelineEvents.journeyId, journeyId));
    // Completing treatmentA now also writes a revenue_events row (the
    // production write path this checkpoint added) — must be deleted before
    // the treatment_opportunities row it references, or the FK constraint
    // rejects the delete below.
    await db.delete(revenueEvents).where(eq(revenueEvents.journeyId, journeyId));
    await db.delete(treatmentOpportunities).where(eq(treatmentOpportunities.journeyId, journeyId));
    await db.delete(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, journeyId));
    await db.delete(journeys).where(eq(journeys.id, journeyId));
    await db.delete(patients).where(eq(patients.id, patientId));
    await queryClient.end();
  });

  it("completing the treatment makes a TREATMENT_COMPLETED conversion-feedback event eligible, carrying the journey's real attribution", async () => {
    const result = await updateTreatmentStatus(db, tenantId, treatmentAId, actorId, "COMPLETED");
    expect(result.ok).toBe(true);

    const [event] = await db.select().from(conversionFeedbackEvents).where(and(eq(conversionFeedbackEvents.journeyId, journeyId), eq(conversionFeedbackEvents.eventType, "TREATMENT_COMPLETED")));
    expect(event).toBeTruthy();
    expect(event.value).toBe(120000);
    expect(event.gclid).toBe("gclid-treatment-trigger-test");
    expect(event.externalCampaignId).toBe("CAMPAIGN_TREATMENT_TRIGGER");
  });

  it("a second treatment completing on the SAME journey does not create a second TREATMENT_COMPLETED event — one milestone, once", async () => {
    await updateTreatmentStatus(db, tenantId, treatmentBId, actorId, "COMPLETED");

    const events = await db.select().from(conversionFeedbackEvents).where(and(eq(conversionFeedbackEvents.journeyId, journeyId), eq(conversionFeedbackEvents.eventType, "TREATMENT_COMPLETED")));
    expect(events.length).toBe(1);
    expect(events[0].value).toBe(120000); // the first one's value, never overwritten by the second
  });

  it("a fixture payload can be built from the recorded event exactly once, and is never sent anywhere", async () => {
    const [event] = await db.select().from(conversionFeedbackEvents).where(and(eq(conversionFeedbackEvents.journeyId, journeyId), eq(conversionFeedbackEvents.eventType, "TREATMENT_COMPLETED")));

    const payload: ConversionFeedbackPayload = {
      eventType: event.eventType,
      externalCampaignId: event.externalCampaignId,
      gclid: event.gclid,
      gbraid: event.gbraid,
      wbraid: event.wbraid,
      fbclid: event.fbclid,
      occurredAt: event.occurredAt,
      value: event.value,
      currency: event.currency,
      idempotencyKey: event.idempotencyKey,
    };

    const wireBody = googleAdsLeadFormsAdapter.buildConversionPayload!(payload, { customerId: "fixture-customer-id" });
    const builtEvent = (wireBody.events as Record<string, unknown>[])[0];
    expect(builtEvent.transactionId).toBe(`${journeyId}:TREATMENT_COMPLETED`);
    expect(builtEvent.conversionValue).toBe(120000);
    expect((builtEvent.adIdentifiers as Record<string, unknown>).gclid).toBe("gclid-treatment-trigger-test");
  });
});

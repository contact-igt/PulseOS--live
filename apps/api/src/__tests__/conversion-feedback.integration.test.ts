import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, conversionFeedbackEvents, journeys, patients, tenants } from "../db/schema.js";
import { recordConversionFeedbackEvent } from "../domain/acquisition/conversion-feedback.service.js";
import { recordTouchpoint } from "../domain/acquisition/attribution.service.js";
import type { NormalizedLead } from "../domain/acquisition/types.js";

// Integration test: requires DATABASE_URL pointed at a migrated (seeded or
// unseeded) PulseOS dev DB — creates its own tenant-scoped rows.

const DATABASE_URL = process.env.DATABASE_URL;

function lead(overrides: Partial<NormalizedLead> = {}): NormalizedLead {
  return {
    externalLeadId: `lead-${Date.now()}-${Math.random()}`,
    externalFormId: null,
    externalAccountId: null,
    externalCampaignId: "CAMPAIGN_CFB_TEST",
    externalAdGroupId: null,
    externalAdId: null,
    name: "Conversion Feedback Test Patient",
    phone: "+919876500033",
    email: null,
    source: "google",
    medium: "cpc",
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    gclid: "gclid-conversion-feedback-test",
    gbraid: null,
    wbraid: null,
    fbclid: null,
    occurredAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe.skipIf(!DATABASE_URL)("conversion feedback foundation — integration", () => {
  let tenantId: string;
  let consentedPatientId: string;
  let consentedJourneyId: string;
  let noConsentPatientId: string;
  let noConsentJourneyId: string;
  let noTouchpointJourneyId: string;

  beforeAll(async () => {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo")).limit(1);
    tenantId = tenant.id;

    const [consentedPatient] = await db.insert(patients).values({ tenantId, name: "Consented CFB Patient", phone: "+919876500033", marketingConsent: true }).returning();
    consentedPatientId = consentedPatient.id;
    const [consentedJourney] = await db.insert(journeys).values({ tenantId, patientId: consentedPatientId, journeyType: "CFB Test", source: "google" }).returning();
    consentedJourneyId = consentedJourney.id;
    await recordTouchpoint(db, { tenantId, patientId: consentedPatientId, journeyId: consentedJourneyId, details: lead(), campaignName: "CFB Test Campaign" });

    const [noConsentPatient] = await db.insert(patients).values({ tenantId, name: "No Consent CFB Patient", phone: "+919876500034", marketingConsent: false }).returning();
    noConsentPatientId = noConsentPatient.id;
    const [noConsentJourney] = await db.insert(journeys).values({ tenantId, patientId: noConsentPatientId, journeyType: "CFB Test No Consent", source: "google" }).returning();
    noConsentJourneyId = noConsentJourney.id;
    await recordTouchpoint(db, { tenantId, patientId: noConsentPatientId, journeyId: noConsentJourneyId, details: lead({ phone: "+919876500034" }), campaignName: "CFB Test Campaign" });

    const [noTouchpointJourney] = await db.insert(journeys).values({ tenantId, patientId: consentedPatientId, journeyType: "CFB Test No Touchpoint", source: "walk_in" }).returning();
    noTouchpointJourneyId = noTouchpointJourney.id;
  });

  afterAll(async () => {
    await db.delete(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, consentedJourneyId));
    await db.delete(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, noConsentJourneyId));
    await db.delete(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, consentedJourneyId));
    await db.delete(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, noConsentJourneyId));
    await db.delete(journeys).where(eq(journeys.id, consentedJourneyId));
    await db.delete(journeys).where(eq(journeys.id, noConsentJourneyId));
    await db.delete(journeys).where(eq(journeys.id, noTouchpointJourneyId));
    await db.delete(patients).where(eq(patients.id, consentedPatientId));
    await db.delete(patients).where(eq(patients.id, noConsentPatientId));
    await queryClient.end();
  });

  it("records a conversion-feedback event for a consent-eligible patient, carrying the journey's attribution context", async () => {
    const result = await recordConversionFeedbackEvent(db, tenantId, consentedJourneyId, "TREATMENT_COMPLETED", 45000, "INR");
    expect(result.ok).toBe(true);
    if (!result.ok || !result.created) throw new Error("expected created:true");

    const [row] = await db.select().from(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.id, result.eventId));
    expect(row.eventType).toBe("TREATMENT_COMPLETED");
    expect(row.value).toBe(45000);
    expect(row.source).toBe("google");
    expect(row.gclid).toBe("gclid-conversion-feedback-test");
    expect(row.externalCampaignId).toBe("CAMPAIGN_CFB_TEST");
  });

  it("never creates an outbound payload for a patient without marketing consent — the row is never written, not written-then-filtered", async () => {
    const result = await recordConversionFeedbackEvent(db, tenantId, noConsentJourneyId, "TREATMENT_COMPLETED", 45000, "INR");
    expect(result).toEqual({ ok: false, reason: "consent_ineligible" });

    const rows = await db.select().from(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, noConsentJourneyId));
    expect(rows.length).toBe(0);
  });

  it("is idempotent — recording the same milestone twice for the same journey never creates a second row", async () => {
    const first = await recordConversionFeedbackEvent(db, tenantId, consentedJourneyId, "REVENUE_RECORDED", 10000, "INR");
    const second = await recordConversionFeedbackEvent(db, tenantId, consentedJourneyId, "REVENUE_RECORDED", 10000, "INR");
    expect(first.ok && first.created).toBe(true);
    expect(second).toEqual({ ok: true, created: false, reason: "already_recorded" });

    const rows = await db.select().from(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.journeyId, consentedJourneyId));
    expect(rows.filter((r) => r.eventType === "REVENUE_RECORDED").length).toBe(1);
  });

  it("a journey with no recorded touchpoint (e.g. a pure walk-in) has nothing meaningful to report — no row is created", async () => {
    const result = await recordConversionFeedbackEvent(db, tenantId, noTouchpointJourneyId, "APPOINTMENT_BOOKED", null, "INR");
    expect(result).toEqual({ ok: true, created: false, reason: "no_attribution" });
  });

  it("returns journey_not_found for an unknown journey id", async () => {
    const result = await recordConversionFeedbackEvent(db, tenantId, "00000000-0000-0000-0000-000000000000", "QUALIFIED_ENQUIRY", null, "INR");
    expect(result).toEqual({ ok: false, reason: "journey_not_found" });
  });
});

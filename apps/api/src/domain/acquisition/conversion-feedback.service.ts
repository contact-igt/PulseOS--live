import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { conversionFeedbackEvents, journeys, patients } from "../../db/schema.js";
import { getAttributionSummary } from "./attribution.service.js";
import type { ConversionFeedbackEventType } from "./types.js";

export type RecordConversionFeedbackResult =
  | { ok: true; created: true; eventId: string }
  | { ok: true; created: false; reason: "already_recorded" | "no_attribution" }
  | { ok: false; reason: "journey_not_found" | "consent_ineligible" };

// The eligibility gate for every conversion-feedback candidate event.
// "If consent is not eligible: do not create outbound user-data conversion
// payload" is enforced literally — an ineligible patient's milestone is
// never even written to conversion_feedback_events, not written-then-
// filtered. Click ids/campaign context are copied from the journey's
// current attribution (attribution.service.ts) at the moment the milestone
// fires — not looked up again later, so the record reflects what was true
// when the event actually happened. This checkpoint only ever builds/records
// candidate events (see adapter buildConversionPayload methods) — nothing
// here calls a real provider endpoint.
export async function recordConversionFeedbackEvent(
  db: Db,
  tenantId: string,
  journeyId: string,
  eventType: ConversionFeedbackEventType,
  value: number | null,
  currency: string,
): Promise<RecordConversionFeedbackResult> {
  const [journey] = await db.select().from(journeys).where(eq(journeys.id, journeyId)).limit(1);
  if (!journey || journey.tenantId !== tenantId) {
    return { ok: false, reason: "journey_not_found" };
  }

  const [patient] = await db.select({ marketingConsent: patients.marketingConsent }).from(patients).where(eq(patients.id, journey.patientId)).limit(1);
  if (!patient?.marketingConsent) {
    return { ok: false, reason: "consent_ineligible" };
  }

  const idempotencyKey = `${journeyId}:${eventType}`;
  const [existing] = await db.select({ id: conversionFeedbackEvents.id }).from(conversionFeedbackEvents).where(eq(conversionFeedbackEvents.idempotencyKey, idempotencyKey)).limit(1);
  if (existing) {
    return { ok: true, created: false, reason: "already_recorded" };
  }

  const attribution = await getAttributionSummary(db, journeyId);
  const touch = attribution.currentLastTouch ?? attribution.firstTouch;
  if (!touch) {
    // No touchpoint exists for this journey at all (e.g. a walk-in with no
    // acquisition connector involved) — there is nothing meaningful to
    // report back to any provider.
    return { ok: true, created: false, reason: "no_attribution" };
  }

  const [row] = await db
    .insert(conversionFeedbackEvents)
    .values({
      tenantId,
      journeyId,
      patientId: journey.patientId,
      eventType,
      value,
      currency,
      source: touch.source,
      externalCampaignId: touch.externalCampaignId,
      gclid: touch.gclid,
      gbraid: touch.gbraid,
      wbraid: touch.wbraid,
      fbclid: touch.fbclid,
      idempotencyKey,
    })
    .returning({ id: conversionFeedbackEvents.id });

  return { ok: true, created: true, eventId: row.id };
}

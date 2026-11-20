import type { DbOrTx } from "../../db/client.js";
import type { NormalizedLead } from "./types.js";
import { ingestNormalizedLead } from "./lead-ingestion.service.js";
import { markEventProcessed, recordConnectorEvent } from "../connector/connector-event.service.js";
import { touchConnectorSuccess } from "../connector/connector.service.js";
import { eq } from "drizzle-orm";
import { connectorEvents } from "../../db/schema.js";

export async function processMetaLead(db: DbOrTx, tenantId: string, connectorId: string,
  lead: NormalizedLead) {
  const event = await recordConnectorEvent(db, { tenantId, connectorId, externalEventId: lead.externalLeadId,
    direction: "inbound", payload: { type: "leadgen" } });
  if (event.duplicate) {
    const [existing] = await db.select({ status: connectorEvents.status }).from(connectorEvents).where(eq(connectorEvents.id, event.eventId));
    if (existing?.status !== "processed") throw new Error("event_already_processing");
    return;
  }
  await ingestNormalizedLead(db, tenantId, lead, {
    description: null,
    journeyTypeFallback: "Meta Lead Ads Enquiry", campaignNameFallback: "Meta Lead Ads Campaign",
    sourceLabel: "Meta Lead Ads", taskDueInHours: 2,
    firstTouchEventType: "meta_lead_received", firstTouchTitle: "Meta Lead Ads enquiry received",
    additionalTouchEventType: "meta_lead_additional_touch", additionalTouchTitle: "Additional Meta Lead Ads touch recorded", connectorId,
  });
  await markEventProcessed(db, event.eventId);
  await touchConnectorSuccess(db, connectorId);
}

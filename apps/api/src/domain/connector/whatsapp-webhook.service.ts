import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { conversations, journeys, messages } from "../../db/schema.js";
import { findOrCreatePatientByPhone } from "../patient/identity.service.js";
import { resolveEndpointByProviderRef } from "./communication-endpoint.service.js";
import { recordConversationActivity } from "../conversation/summary/conversation-session.service.js";
import type { InboundMessageEvent, MessageStatusEvent } from "./types.js";

// Journey resolution for a WhatsApp conversation is deliberately more
// conservative than the calls precedent (call-webhook.service.ts's
// findMostRecentActiveJourney, "most recent active Journey wins"). WhatsApp
// is far more likely than a single inbound phone line to have a patient with
// several concurrent active Journeys texting the same thread, and the
// product's own north star ("Patient != Journey, a patient can have multiple
// concurrent journeys") means guessing "most recent" risks silently
// mislabelling a thread's Timeline events under the wrong Journey.
//
// Today's schema gives no deterministic tie-breaker between several active
// Journeys for one patient once there IS more than one: `journeys` carries
// no branchId/specialty field that could be matched against
// CommunicationEndpoint.branchId, and InboundMessageEvent carries no
// campaign/click-id context (no ctwa_clid/referral parsing exists). So:
//   0 active Journeys  -> null (Patient-level conversation; not an error)
//   1 active Journey   -> that Journey (deterministic, unambiguous)
//   >1 active Journeys -> null (genuinely ambiguous; never guess)
async function resolveJourneyForNewConversation(db: Db, tenantId: string, patientId: string): Promise<string | null> {
  const activeJourneys = await db
    .select({ id: journeys.id })
    .from(journeys)
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.patientId, patientId), ne(journeys.stage, "completed"), ne(journeys.stage, "lost")))
    .orderBy(desc(journeys.createdAt));
  if (activeJourneys.length === 1) return activeJourneys[0]!.id;
  return null;
}

async function findOrCreateConversation(
  db: Db,
  tenantId: string,
  connectorId: string,
  patientId: string,
  externalThreadId: string,
  lastMessageAt: Date,
  communicationEndpointId: string | null,
) {
  // Matches the unique index exactly (connectorId, communicationEndpointId,
  // externalThreadId): the same patient (same externalThreadId — their own
  // wa_id) messaging two different configured hospital lines must get two
  // separate conversations, not one merged thread permanently mislabelled
  // with whichever line arrived first. Two `undefined` endpoints (neither
  // line resolved yet — the common case before any admin configures one)
  // still fold into the same conversation, matching prior behavior.
  const endpointCondition = communicationEndpointId ? eq(conversations.communicationEndpointId, communicationEndpointId) : isNull(conversations.communicationEndpointId);
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.connectorId, connectorId), eq(conversations.externalThreadId, externalThreadId), endpointCondition))
    .limit(1);
  if (existing) {
    // An already-set journeyId is never reassigned or cleared here — the
    // established thread's own link is itself the strongest evidence
    // available, stronger than re-running "most recent"/"single active"
    // resolution on every later message (which could otherwise flip-flop a
    // conversation's Journey as the patient's Journey set changes over
    // time). Only a still-null link is ever backfilled, and only once it
    // becomes deterministically resolvable (exactly one active Journey).
    if (!existing.journeyId) {
      const resolvedJourneyId = await resolveJourneyForNewConversation(db, tenantId, patientId);
      if (resolvedJourneyId) {
        // Compare-and-swap: re-guard on journeyId still being null at UPDATE
        // time, not just at the SELECT above. Two concurrent deliveries for
        // the same still-unlinked conversation (e.g. a provider redelivery)
        // could otherwise both resolve independently and race on the write —
        // this makes only the first one actually land; the second affects
        // zero rows and falls through to the re-fetch below, same pattern as
        // treatment.service.ts's conditional status-transition UPDATE.
        const [updated] = await db
          .update(conversations)
          .set({ journeyId: resolvedJourneyId })
          .where(and(eq(conversations.id, existing.id), isNull(conversations.journeyId)))
          .returning();
        if (updated) return updated;
        const [refetched] = await db.select().from(conversations).where(eq(conversations.id, existing.id)).limit(1);
        return refetched!;
      }
    }
    return existing;
  }

  const journeyId = await resolveJourneyForNewConversation(db, tenantId, patientId);

  // No AI runtime exists yet in this checkpoint (Group U) — a brand-new
  // live conversation is never silently marked as AI-handled. It starts
  // HUMAN_REQUIRED so it surfaces in the triage queue for a real person.
  const [created] = await db
    .insert(conversations)
    .values({
      tenantId,
      patientId,
      channel: "WHATSAPP",
      connectorId,
      externalThreadId,
      ownershipState: "HUMAN_REQUIRED",
      lastMessageAt,
      communicationEndpointId,
      journeyId,
    })
    .returning();
  return created;
}

export async function processInboundWhatsAppMessage(db: Db, tenantId: string, connectorId: string, event: InboundMessageEvent): Promise<{ conversationId: string; patientId: string }> {
  const patient = await findOrCreatePatientByPhone(db, tenantId, event.fromPhone, event.fromName ?? null);
  // Best-effort, exact match only: resolves when an admin has configured a
  // CommunicationEndpoint whose providerRef equals this message's real
  // phone_number_id. No match (not configured yet, or an unrecognized
  // number) leaves it null rather than guessing.
  const endpoint = event.phoneNumberId ? await resolveEndpointByProviderRef(db, tenantId, connectorId, event.phoneNumberId) : null;
  const conversation = await findOrCreateConversation(db, tenantId, connectorId, patient.id, event.externalThreadId, event.occurredAt, endpoint?.id ?? null);

  await db.insert(messages).values({
    tenantId,
    conversationId: conversation.id,
    senderType: "patient",
    body: event.body,
    sentAt: event.occurredAt,
    connectorId,
    providerMessageId: event.externalEventId,
  });

  await db
    .update(conversations)
    .set({ lastMessageAt: event.occurredAt })
    .where(eq(conversations.id, conversation.id));

  // The Timeline gets one concise line per conversation session (kept up to date here), not one per message;
  // the summary deadline is pushed out by the idle window.
  await recordConversationActivity(db, tenantId, conversation.id, { at: event.occurredAt, sender: "patient" });

  return { conversationId: conversation.id, patientId: patient.id };
}

export async function processWhatsAppStatusUpdate(db: Db, connectorId: string, event: MessageStatusEvent): Promise<{ matched: boolean }> {
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.connectorId, connectorId), eq(messages.providerMessageId, event.providerMessageId)))
    .limit(1);
  if (!existing) return { matched: false };

  await db.update(messages).set({ deliveryStatus: event.status }).where(eq(messages.id, existing.id));
  return { matched: true };
}

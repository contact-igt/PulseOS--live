import type { FastifyInstance, FastifyRequest } from "fastify";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "./connector.service.js";
import { markEventFailed, markEventProcessed, recordConnectorEvent } from "./connector-event.service.js";
import { getAcquisitionAdapter, getMessagingAdapter, getTelephonyAdapter } from "./registry.js";
import { processInboundWhatsAppMessage, processWhatsAppStatusUpdate } from "./whatsapp-webhook.service.js";
import { persistInboundCall } from "./call-webhook.service.js";
import { applyDeliveryStatus } from "../notification/notification.service.js";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { processProviderLead } from "../acquisition/lead-webhook.service.js";
import { ingestNormalizedLead } from "../acquisition/lead-ingestion.service.js";

interface RequestWithRawBody extends FastifyRequest {
  rawBody?: string;
}

// Webhooks are unauthenticated by session (the caller is Meta/Runo, not a
// PulseOS user) — every request is authenticated instead via the provider's
// own signature/shared-secret mechanism, verified against this tenant's
// connector secrets. Registered outside the session-auth protected group.
export async function webhookRoutes(app: FastifyInstance) {
  // Capture the raw request body before JSON parsing so WhatsApp's HMAC
  // signature (computed over the exact bytes Meta sent) can be verified.
  // Scoped to this plugin only via Fastify's encapsulation — the rest of
  // the app keeps the default JSON parser untouched.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as RequestWithRawBody).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/webhooks/whatsapp/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector) return reply.status(404).send("not_found");

    const adapter = getMessagingAdapter(connector.provider);
    if (!adapter) return reply.status(404).send("not_found");

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(403).send("forbidden");

    const query = request.query as Record<string, string>;
    const challenge = adapter.verifyWebhookChallenge(query, secrets);
    if (challenge === null) return reply.status(403).send("forbidden");
    return reply.status(200).send(challenge);
  });

  app.post("/webhooks/whatsapp/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getMessagingAdapter(connector.provider);
    if (!adapter) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(200).send({ ok: true });

    const rawBody = (request as RequestWithRawBody).rawBody ?? "";
    const signatureHeader = request.headers["x-hub-signature-256"] as string | undefined;
    if (!adapter.verifyWebhookSignature(rawBody, signatureHeader, secrets)) {
      app.log.warn({ connectorId }, "WhatsApp webhook signature rejected");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const parsed = adapter.parseWebhookPayload(request.body);

    // Enabled is a tenant switch, independent of the connector: inbound conversations need the Inbox, delivery
    // statuses need either WhatsApp capability. A disabled capability is acknowledged and ignored (no retries).
    const caps = await tenantCapabilityMap(app.db, connector.tenantId);
    if (!caps.WHATSAPP_INBOX) parsed.messages = [];
    if (!caps.WHATSAPP_INBOX && !caps.WHATSAPP_NOTIFICATIONS) parsed.statuses = [];

    for (const msg of parsed.messages) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: msg.externalEventId,
        direction: "inbound",
        payload: { type: "message" },
      });
      if (duplicate) continue;

      try {
        await processInboundWhatsAppMessage(app.db, connector.tenantId, connectorId, msg);
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
      } catch (err) {
        await markEventFailed(app.db, eventId, (err as Error).message);
        await touchConnectorError(app.db, connectorId, (err as Error).message);
      }
    }

    for (const status of parsed.statuses) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: status.externalEventId,
        direction: "inbound",
        payload: { type: "status" },
      });
      if (duplicate) continue;

      try {
        await processWhatsAppStatusUpdate(app.db, connectorId, status);
        // The same provider status also moves a reminder/follow-up message along (sent → delivered → read, or failed).
        await applyDeliveryStatus(app.db, connector.tenantId, status.providerMessageId, status.status, status.occurredAt);
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
      } catch (err) {
        await markEventFailed(app.db, eventId, (err as Error).message);
      }
    }

    return reply.status(200).send({ ok: true });
  });

  app.post("/webhooks/runo/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getTelephonyAdapter(connector.provider);
    if (!adapter) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(200).send({ ok: true });

    if (!adapter.verifyWebhook(request.body, request.headers as Record<string, string | undefined>, secrets)) {
      app.log.warn({ connectorId }, "Runo webhook authentication rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }

    if (!(await tenantCapabilityMap(app.db, connector.tenantId)).RUNO_CALLING) return reply.status(200).send({ ok: true });

    const calls = adapter.parseWebhookPayload(request.body);
    for (const call of calls) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: call.externalEventId,
        direction: "inbound",
        payload: { type: "call" },
      });
      if (duplicate) continue;

      try {
        await persistInboundCall(app.db, connector.tenantId, connectorId, call);
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
      } catch (err) {
        await markEventFailed(app.db, eventId, (err as Error).message);
        await touchConnectorError(app.db, connectorId, (err as Error).message);
      }
    }

    return reply.status(200).send({ ok: true });
  });

  app.get("/webhooks/meta-lead-ads/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector) return reply.status(404).send("not_found");

    const adapter = getAcquisitionAdapter(connector.provider);
    if (!adapter?.verifyWebhookChallenge) return reply.status(404).send("not_found");

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(403).send("forbidden");

    const query = request.query as Record<string, string>;
    const challenge = adapter.verifyWebhookChallenge(query, secrets);
    if (challenge === null) return reply.status(403).send("forbidden");
    return reply.status(200).send(challenge);
  });

  app.post("/webhooks/meta-lead-ads/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getAcquisitionAdapter(connector.provider);
    if (!adapter?.parseWebhookLeadReferences || !adapter.fetchLead) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(200).send({ ok: true });

    const rawBody = (request as RequestWithRawBody).rawBody ?? "";
    const signatureHeader = request.headers["x-hub-signature-256"] as string | undefined;
    if (adapter.verifyWebhookSignature && !adapter.verifyWebhookSignature(rawBody, signatureHeader, secrets)) {
      app.log.warn({ connectorId }, "Meta Lead Ads webhook signature rejected");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const config = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase() };
    const refs = adapter.parseWebhookLeadReferences(request.body);

    for (const ref of refs) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: ref.externalLeadId,
        direction: "inbound",
        payload: { type: "leadgen" },
      });
      if (duplicate) continue;

      try {
        await processProviderLead(app.db, connector.tenantId, adapter, ref, config, secrets, {
          journeyTypeFallback: "Meta Lead Ads Enquiry",
          campaignNameFallback: "Meta Lead Ads Campaign",
          sourceLabel: "Meta Lead Ads",
          taskDueInHours: 2,
          firstTouchEventType: "meta_lead_received",
          firstTouchTitle: "Meta Lead Ads enquiry received",
          additionalTouchEventType: "meta_lead_additional_touch",
          additionalTouchTitle: "Additional Meta Lead Ads touch recorded",
          connectorId,
        });
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
      } catch (err) {
        await markEventFailed(app.db, eventId, (err as Error).message);
        await touchConnectorError(app.db, connectorId, (err as Error).message);
      }
    }

    return reply.status(200).send({ ok: true });
  });

  // Google's contract (unlike Meta's) is a single POST per lead carrying the
  // full submission — no separate fetch step, no GET challenge handshake,
  // and auth is a plaintext google_key field inside the body rather than a
  // signed header. Response shape follows Google's own documented contract:
  // {} on success, {message} on error, 4xx non-retryable / 5xx retryable.
  app.post("/webhooks/google-ads-lead-forms/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.status === "DISABLED") return reply.status(200).send({});

    const adapter = getAcquisitionAdapter(connector.provider);
    if (!adapter?.verifyWebhookKey || !adapter.parseWebhookLead) return reply.status(200).send({});

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(200).send({});

    if (!adapter.verifyWebhookKey(request.body, secrets)) {
      app.log.warn({ connectorId }, "Google Ads Lead Forms webhook key rejected");
      return reply.status(400).send({ message: "invalid_google_key" });
    }

    const leads = adapter.parseWebhookLead(request.body);
    for (const lead of leads) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: lead.externalLeadId,
        direction: "inbound",
        payload: { type: "lead_form" },
      });
      if (duplicate) continue;

      try {
        await ingestNormalizedLead(app.db, connector.tenantId, lead, {
          journeyTypeFallback: "Google Ads Lead Enquiry",
          campaignNameFallback: "Google Ads Lead Forms Campaign",
          sourceLabel: "Google Ads Lead Forms",
          taskDueInHours: 2,
          firstTouchEventType: "google_lead_received",
          firstTouchTitle: "Google Ads lead enquiry received",
          additionalTouchEventType: "google_lead_additional_touch",
          additionalTouchTitle: "Additional Google Ads lead touch recorded",
          connectorId,
        });
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
      } catch (err) {
        await markEventFailed(app.db, eventId, (err as Error).message);
        await touchConnectorError(app.db, connectorId, (err as Error).message);
        return reply.status(500).send({ message: "processing_failed" });
      }
    }

    return reply.status(200).send({});
  });
}

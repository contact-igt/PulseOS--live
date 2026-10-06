import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { notifications } from "../../db/schema.js";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "./connector.service.js";
import { markEventFailed, markEventProcessed, recordConnectorEvent } from "./connector-event.service.js";
import { getAcquisitionAdapter, getMessagingAdapter, getTelephonyAdapter } from "./registry.js";
import { processInboundWhatsAppMessage, processWhatsAppStatusUpdate } from "./whatsapp-webhook.service.js";
import { persistInboundCall } from "./call-webhook.service.js";
import { applyDeliveryStatus } from "../notification/notification.service.js";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { processProviderLead } from "../acquisition/lead-webhook.service.js";
import { ingestNormalizedLead } from "../acquisition/lead-ingestion.service.js";
import { isCredentialName, withoutCredentials } from "../../lib/credential-redaction.js";
import { isRecognisedCcsField } from "./adapters/ccs-normalizer.js";
import { shapeOf } from "../../lib/payload-shape.js";
import { randomUUID } from "node:crypto";

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
    } catch {
      // A body that is not JSON is the caller's mistake: 400, not an anonymous 500 (and no parser detail echoed).
      done(Object.assign(new Error("invalid_json"), { statusCode: 400 }), undefined);
    }
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try {
      const parsed = Object.fromEntries(new URLSearchParams(body as string));
      done(null, parsed);
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

  async function handleCcsWebhook(request: FastifyRequest, reply: FastifyReply) {
    const { connectorId, token } = request.params as { connectorId: string; token?: string };
    const connector = await getConnectorById(app.db, connectorId);
    // Unknown, disabled or not-a-CCS connector: acknowledged and ignored, so the URL cannot be probed for what exists.
    if (!connector || connector.status === "DISABLED" || connector.provider !== "ccs_ivr") return reply.status(200).send({ ok: true });

    const adapter = getTelephonyAdapter(connector.provider);
    if (!adapter) return reply.status(200).send({ ok: true });

    // Authentication fails closed: no stored credentials means no way to authenticate, which is a refusal, never a pass.
    // (An unreadable payload throws and the error handler answers 503; the provider retries and nothing is stored.)
    const secrets = (await getConnectorSecrets(app.db, connectorId)) ?? {};

    const rawPayload = {
      ...((request.query as Record<string, unknown>) || {}),
      ...(typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {}),
    };

    // The dedicated token in the URL path reaches the adapter as one more credential (never as a header the caller controls).
    const credentialHeaders = { ...(request.headers as Record<string, string | undefined>), "x-webhook-token": token } as Record<string, string | undefined>;
    if (!token) delete credentialHeaders["x-webhook-token"];
    if (!adapter.verifyWebhook(rawPayload, credentialHeaders, secrets)) {
      // To diagnose a 401 without a secret: WHICH kinds of credential arrived (names only) vs which are saved. Never a value.
      const ua = request.headers["user-agent"];
      request.log.warn(
        {
          ccs: {
            connectorId,
            presentedHeaders: Object.keys(request.headers).filter((h) => /key|secret|token|auth|signature/i.test(h)),
            presentedParams: Object.keys(rawPayload).filter(isCredentialName),
            pathToken: !!token,
            savedKeyKinds: ["apiKey", "secretKey", "integrationKey", "webhookToken"].filter((k) => typeof secrets[k] === "string" && (secrets[k] as string).trim() !== ""),
            userAgent: typeof ua === "string" ? ua.slice(0, 80) : null,
            contentType: typeof request.headers["content-type"] === "string" ? request.headers["content-type"].split(";")[0] : null,
          },
        },
        "CCS IVR webhook authentication rejected",
      );
      return reply.status(401).send({ error: "unauthorized" });
    }

    if (!(await tenantCapabilityMap(app.db, connector.tenantId)).CCS_IVR) return reply.status(200).send({ ok: true });

    // The credential has done its job. It must not be stored with the event, copied into the call's metadata or logged.
    const safePayload = withoutCredentials(rawPayload);
    if (Object.keys(safePayload).length === 0) return reply.status(200).send({ ok: true, accepted: 0 }); // a provider's setup ping

    // Field NAMES only (never a value): what the first real CCS report actually looks like, and what is already mapped.
    const names = Object.keys(safePayload);
    const fieldNames = { recognised: names.filter(isRecognisedCcsField), unrecognised: names.filter((n) => !isRecognisedCcsField(n)) };
    const calls = adapter.parseWebhookPayload(safePayload);
    if (calls.length === 0) {
      request.log.warn({ ccs: { connectorId, fieldNames, reason: "no_caller_number" } }, "ccs call report not normalized");
      // Keep the SHAPE (names, category-like values only) so the real payload can be read in payload-shapes: never the call's own data.
      const { eventId } = await recordConnectorEvent(app.db, { tenantId: connector.tenantId, connectorId, externalEventId: `ccs:unparsed:${randomUUID()}`, direction: "inbound", payload: { type: "unparsed", raw: shapeOf(safePayload) } });
      await markEventFailed(app.db, eventId, "no_caller_number");
      return reply.status(422).send({ error: "invalid_payload" });
    }
    request.log.info({ ccs: { connectorId, events: calls.length, fieldNames } }, "ccs call report received");
    for (const call of calls) {
      const { duplicate, eventId } = await recordConnectorEvent(app.db, {
        tenantId: connector.tenantId,
        connectorId,
        externalEventId: call.externalEventId,
        direction: "inbound",
        payload: { type: "call", raw: safePayload },
      });
      const facts = { connectorId, direction: call.direction, outcome: call.status, idDerived: call.metadata.idDerived === true, recordingAvailable: !!call.recordingUrl };
      if (duplicate) {
        request.log.info({ ccs: { ...facts, callSaved: false, duplicate: true, taskCreated: false, stage: "event" } }, "ccs call ingested");
        continue;
      }

      try {
        const summary = await persistInboundCall(app.db, connector.tenantId, connectorId, call);
        await markEventProcessed(app.db, eventId);
        await touchConnectorSuccess(app.db, connectorId);
        request.log.info({ ccs: { ...facts, ...summary } }, "ccs call ingested");
      } catch (err) {
        // Class and database code only: an error MESSAGE can carry the query and its parameters (a phone number).
        request.log.error({ ccs: { ...facts, stage: "ingest", errorName: (err as Error).name, dbCode: (err as { code?: string }).code ?? null } }, "ccs call ingestion failed");
        await markEventFailed(app.db, eventId, (err as Error).message);
        await touchConnectorError(app.db, connectorId, (err as Error).message);
      }
    }

    return reply.status(200).send({ ok: true });
  }

  app.post("/webhooks/ccs/:connectorId", handleCcsWebhook);
  app.get("/webhooks/ccs/:connectorId", handleCcsWebhook);
  app.post("/webhooks/ccs/:connectorId/:token", handleCcsWebhook);
  app.get("/webhooks/ccs/:connectorId/:token", handleCcsWebhook);

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

  // WhatsNexus Delivery Status & Inbound Message Webhook
  app.post("/webhooks/whatsnexus", async (request, reply) => {
    return handleWhatsNexusCallback(app.db, request, reply);
  });

  app.post("/webhooks/whatsnexus/:tenantId", async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    return handleWhatsNexusCallback(app.db, request, reply, tenantId);
  });
}

async function handleWhatsNexusCallback(db: Db, request: FastifyRequest, reply: FastifyReply, explicitTenantId?: string) {
  const body = (request.body as Record<string, any>) ?? {};
  const status = (body.status || body.event || body.type || "")?.toLowerCase();
  const providerMessageId = String(body.messageId || body.providerMessageId || body.call_Id || body.id || "");
  const now = new Date();

  if (providerMessageId && ["sent", "delivered", "read", "failed"].includes(status)) {
    let tenantId = explicitTenantId;
    if (!tenantId) {
      const [n] = await db
        .select({ tenantId: notifications.tenantId })
        .from(notifications)
        .where(eq(notifications.providerMessageId, providerMessageId))
        .limit(1);
      tenantId = n?.tenantId;
    }
    if (tenantId) {
      await applyDeliveryStatus(db, tenantId, providerMessageId, status as any, now);
      return reply.status(200).send({ ok: true, updated: true });
    }
  }

  return reply.status(200).send({ ok: true, received: true });
}

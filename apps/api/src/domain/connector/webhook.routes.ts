import { resolveEndpointByProviderRef } from "./communication-endpoint.service.js";
import { eq } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.js";
import { connectorEvents } from "../../db/schema.js";
import { emitIntegrationEvent } from "../integration/domain-events.js";
import type { InboundCallEvent } from "./types.js";
import { admitMetaLead, fetchBoundMetaLead } from "../acquisition/suspended-meta-leads.service.js";
import { lockActiveHospital } from "../tenant/hospital-lifecycle.policy.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getConnectorById, getConnectorByTenantAndProvider, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "./connector.service.js";
import { markEventFailed, markEventProcessed, recordConnectorEvent, type RecordEventInput } from "./connector-event.service.js";
import { getAcquisitionAdapter, getMessagingAdapter, getTelephonyAdapter } from "./registry.js";
import { processInboundWhatsAppMessage, processOutboundWhatsAppMessage, processWhatsAppStatusUpdate } from "./whatsapp-webhook.service.js";
import { storeInboundCall } from "./call-webhook.service.js";
import { applyDeliveryStatus, applyWhatsNexusStatus, WHATSNEXUS_PROVIDER } from "../notification/notification.service.js";
import { parseWhatsNexusCallback, verifyWhatsNexusCallback } from "./whatsnexus-callback.js";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { ingestNormalizedLead } from "../acquisition/lead-ingestion.service.js";

async function processConnectorDelivery<T>(db: Db, input: RecordEventInput, requiresActive: boolean, process: (tx: Tx) => Promise<T>, acknowledgedFailure?: (value: T) => string | undefined) {
  try {
    return await db.transaction(async (tx) => {
      if (requiresActive && !(await lockActiveHospital(tx, input.tenantId))) return { kind: "unavailable" } as const;
      const event = await recordConnectorEvent(tx, input);
      if (event.duplicate) {
        const [prior] = await tx.select({ status: connectorEvents.status }).from(connectorEvents).where(eq(connectorEvents.id, event.eventId));
        return { kind: prior?.status === "processed" ? "duplicate" : "failed" } as const;
      }
      const value = await process(tx);
      const failure = acknowledgedFailure?.(value);
      if (failure) {
        await markEventFailed(tx, event.eventId, failure);
      } else {
        await markEventProcessed(tx, event.eventId);
        await touchConnectorSuccess(tx, input.connectorId);
      }
      return { kind: "processed", value } as const;
    });
  } catch {
    return { kind: "failed" } as const;
  }
}

async function processCallDeliveries(db: Db, tenantId: string, connectorId: string, calls: InboundCallEvent[], reply: FastifyReply) {
  if (!calls.length && !(await db.transaction((tx) => lockActiveHospital(tx, tenantId)))) {
    return reply.status(503).send({ error: "intake_unavailable" });
  }
  for (const call of calls) {
    const outcome = await processConnectorDelivery(db, {
      tenantId, connectorId, externalEventId: call.externalEventId, direction: "inbound", payload: { type: "call" },
    }, true, (tx) => storeInboundCall(tx, tenantId, connectorId, call));
    if (outcome.kind === "unavailable") return reply.status(503).send({ error: "intake_unavailable" });
    if (outcome.kind === "failed") return reply.status(500).send({ error: "processing_failed" });
    if (outcome.kind === "processed" && outcome.value) emitIntegrationEvent(outcome.value);
  }
  return reply.status(200).send({ ok: true });
}

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
    if (!secrets) return reply.status(401).send({ error: "unauthorized" });

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
    let unavailable = false;
    let failed = false;
    let wrongBinding = false;
    const configuredNumber = (connector.configuration as Record<string, unknown> | null)?.phoneNumberId;
    const matchesNumber = async (number: string | null | undefined) =>
      connector.mode === "FIXTURE" || Boolean(number && (configuredNumber === number ||
        (await resolveEndpointByProviderRef(app.db, connector.tenantId, connectorId, number))?.isActive));
    if (!caps.WHATSAPP_INBOX) parsed.messages = [];
    if (!caps.WHATSAPP_INBOX && !caps.WHATSAPP_NOTIFICATIONS) parsed.statuses = [];

    for (const msg of parsed.messages) {
      if (!(await matchesNumber(msg.phoneNumberId))) {
        wrongBinding = true;
        continue;
      }
      const outcome = await processConnectorDelivery(app.db, {
        tenantId: connector.tenantId, connectorId, externalEventId: msg.externalEventId,
        direction: "inbound", payload: { type: "message" },
      }, true, (tx) => processInboundWhatsAppMessage(tx, connector.tenantId, connectorId, msg));
      unavailable ||= outcome.kind === "unavailable";
      failed ||= outcome.kind === "failed";
    }
    for (const status of parsed.statuses) {
      if (!(await matchesNumber(status.phoneNumberId))) {
        wrongBinding = true;
        continue;
      }
      const outcome = await processConnectorDelivery(app.db, {
        tenantId: connector.tenantId, connectorId, externalEventId: status.externalEventId,
        direction: "inbound", payload: { type: "status" },
      }, false, async (tx) => {
        await processWhatsAppStatusUpdate(tx, connectorId, status);
        await applyDeliveryStatus(tx, connector.tenantId, status.providerMessageId, status.status, status.occurredAt);
      });
      failed ||= outcome.kind === "failed";
    }

    if (failed) return reply.status(500).send({ error: "processing_failed" });
    if (unavailable) return reply.status(503).send({ error: "intake_unavailable" });
    if (wrongBinding) return reply.status(403).send({ error: "wrong_phone_binding" });
    return reply.status(200).send({ ok: true });
  });

  app.post("/webhooks/runo/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (connector?.provider !== "runo" || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getTelephonyAdapter(connector.provider);
    if (!adapter) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(401).send({ error: "unauthorized" });

    if (!adapter.verifyWebhook(request.body, request.headers as Record<string, string | undefined>, secrets)) {
      app.log.warn({ connectorId }, "Runo webhook authentication rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }

    if (!(await tenantCapabilityMap(app.db, connector.tenantId)).RUNO_CALLING) return reply.status(200).send({ ok: true });

    return processCallDeliveries(app.db, connector.tenantId, connectorId, adapter.parseWebhookPayload(request.body), reply);
  });

  async function handleCcsWebhook(request: FastifyRequest, reply: FastifyReply) {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (connector?.provider !== "ccs_ivr" || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getTelephonyAdapter(connector.provider);
    if (!adapter) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(401).send({ error: "unauthorized" });

    const rawPayload = {
      ...((request.query as Record<string, unknown>) || {}),
      ...(typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {}),
    };

    if (!adapter.verifyWebhook(rawPayload, request.headers as Record<string, string | undefined>, secrets)) {
      app.log.warn({ connectorId }, "CCS IVR webhook authentication rejected");
      return reply.status(401).send({ error: "unauthorized" });
    }

    if (!(await tenantCapabilityMap(app.db, connector.tenantId)).CCS_IVR) return reply.status(200).send({ ok: true });

    return processCallDeliveries(app.db, connector.tenantId, connectorId, adapter.parseWebhookPayload(rawPayload), reply);
  }

  app.post("/webhooks/ccs/:connectorId", handleCcsWebhook);
  app.get("/webhooks/ccs/:connectorId", handleCcsWebhook);

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

  app.post("/webhooks/meta-lead-ads/:connectorId", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.status === "DISABLED") return reply.status(200).send({ ok: true });

    const adapter = getAcquisitionAdapter(connector.provider);
    if (!adapter?.parseWebhookLeadReferences || !adapter.fetchLead) return reply.status(200).send({ ok: true });

    const secrets = await getConnectorSecrets(app.db, connectorId);
    if (!secrets) return reply.status(401).send({ error: "unauthorized" });

    const rawBody = (request as RequestWithRawBody).rawBody ?? "";
    const signatureHeader = request.headers["x-hub-signature-256"] as string | undefined;
    if (!adapter.verifyWebhookSignature?.(rawBody, signatureHeader, secrets)) {
      app.log.warn({ connectorId }, "Meta Lead Ads webhook signature rejected");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const refs = adapter.parseWebhookLeadReferences(request.body);
    if (refs.length > 50) return reply.status(413).send({ error: "batch_too_large" });
    let unavailable = false;
    for (const ref of refs) {
      try {
        const verify = (current: Record<string, unknown>) => adapter.verifyWebhookSignature?.(rawBody, signatureHeader, current) === true;
        let admission = await admitMetaLead(app.db, connector.tenantId, connectorId, ref, verify);
        if (admission === "fetch") {
          const lead = await fetchBoundMetaLead(connector, secrets, ref).catch(() => null);
          admission = await admitMetaLead(app.db, connector.tenantId, connectorId, ref, verify,
            lead ? { connector, secrets, lead } : undefined);
        }
        if (admission === "unavailable" || admission === "fetch") unavailable = true;
      } catch {
        unavailable = true;
      }
    }

    // Items commit independently. A rejected reference must not starve valid references in the same delivery.
    if (unavailable) return reply.status(503).send({ error: "intake_unavailable" });
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
    if (!secrets) return reply.status(400).send({ message: "invalid_google_key" });

    if (!adapter.verifyWebhookKey(request.body, secrets)) {
      app.log.warn({ connectorId }, "Google Ads Lead Forms webhook key rejected");
      return reply.status(400).send({ message: "invalid_google_key" });
    }

    const leads = adapter.parseWebhookLead(request.body);
    if (!leads.length) return reply.status(400).send({ message: "invalid_lead" });
    const outcome = await app.db.transaction(async (tx) => {
      if (!(await lockActiveHospital(tx, connector.tenantId))) return "unavailable";
      for (const lead of leads) {
        const { duplicate, eventId } = await recordConnectorEvent(tx, {
          tenantId: connector.tenantId,
          connectorId,
          externalEventId: lead.externalLeadId,
          direction: "inbound",
          payload: { type: "lead_form" },
        });
        if (duplicate) {
          const [prior] = await tx.select({ status: connectorEvents.status }).from(connectorEvents).where(eq(connectorEvents.id, eventId));
          if (prior?.status !== "processed") return "failed";
          continue;
        }
        try {
          await tx.transaction(async (work) => {
            await ingestNormalizedLead(work, connector.tenantId, lead, {
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
            await markEventProcessed(work, eventId);
            await touchConnectorSuccess(work, connectorId);
          });
        } catch {
          await markEventFailed(tx, eventId, "google_lead_processing_failed");
          await touchConnectorError(tx, connectorId, "google_lead_processing_failed");
          return "failed";
        }
      }
      return "accepted";
    });

    if (outcome === "unavailable") return reply.status(503).send({ message: "intake_unavailable" });
    if (outcome === "failed") return reply.status(500).send({ message: "processing_failed" });
    return reply.status(200).send({});
  });

  // WhatsNexus delivery-status callbacks. Authenticated by an HMAC over `${timestamp}.${rawBody}` with this hospital's own
  // callback secret (connector_secrets); the tenant in the URL is only the lookup key for that secret and is never trusted
  // by itself. Unsigned, stale, wrongly signed or other-tenant requests change nothing.
  app.post("/webhooks/whatsnexus", async (request, reply) => handleWhatsNexusCallback(app, request, reply));
  app.post("/webhooks/whatsnexus/:tenantId", async (request, reply) => handleWhatsNexusCallback(app, request, reply, (request.params as { tenantId: string }).tenantId));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleWhatsNexusCallback(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, explicitTenantId?: string) {
  const db = app.db;
  const header = (name: string) => {
    const v = request.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const tenantId = explicitTenantId ?? header("x-pulseos-tenant-id") ?? "";
  const unauthorized = () => reply.status(401).send({ error: "unauthorized" });
  if (!UUID_RE.test(tenantId)) return unauthorized();

  const connector = await getConnectorByTenantAndProvider(db, tenantId, WHATSNEXUS_PROVIDER);
  const secrets = connector && connector.status !== "DISABLED" ? await getConnectorSecrets(db, connector.id) : null;
  const auth = verifyWhatsNexusCallback(secrets, (request as RequestWithRawBody).rawBody ?? "", header("x-whatsnexus-timestamp"), header("x-whatsnexus-signature"));
  if (!connector || auth !== "ok") {
    app.log.warn({ tenantId, auth }, "WhatsNexus callback rejected");
    return unauthorized();
  }

  const parsed = parseWhatsNexusCallback(request.body);
  if (!parsed.ok) return reply.status(400).send({ error: "invalid_payload", reason: parsed.reason });
  const event = parsed.event;

  // The setup test from WhatsNexus: authenticated above (so it also proves the secret), then answered. It records and changes nothing.
  if (event.kind === "ping") return reply.status(200).send({ ok: true, pong: true });

  const caps = await tenantCapabilityMap(db, tenantId);
  if (event.kind === "outbound") {
    if (!caps.WHATSAPP_INBOX) return reply.status(200).send({ ok: true, ignored: true });
    const outcome = await processConnectorDelivery(db, {
      tenantId, connectorId: connector.id, externalEventId: `whatsnexus:${event.eventId}`,
      direction: "inbound", payload: { type: "whatsnexus_outbound", sender: event.sender, attachmentCount: event.attachments.length },
    }, false, (tx) => processOutboundWhatsAppMessage(tx, tenantId, connector.id, event));
    if (outcome.kind === "failed") return reply.status(500).send({ error: "processing_failed" });
    if (outcome.kind === "duplicate") return reply.status(200).send({ ok: true, duplicate: true });
    if (outcome.kind === "processed" && outcome.value === "unknown_thread") {
      return reply.status(200).send({ ok: true, applied: false, reason: outcome.value });
    }
    return reply.status(200).send(outcome.kind === "processed" && outcome.value === "duplicate"
      ? { ok: true, duplicate: true } : { ok: true, applied: true });
  }
  if (event.kind === "inbound") {
    if (!caps.WHATSAPP_INBOX) {
      const active = await db.transaction((tx) => lockActiveHospital(tx, tenantId));
      return active ? reply.status(200).send({ ok: true, ignored: true }) : reply.status(503).send({ error: "intake_unavailable" });
    }
    const outcome = await processConnectorDelivery(db, {
      tenantId, connectorId: connector.id, externalEventId: `whatsnexus:${event.eventId}`,
      direction: "inbound", payload: { type: "whatsnexus_inbound", attachmentCount: event.attachments.length },
    }, true, (tx) => processInboundWhatsAppMessage(tx, tenantId, connector.id, event));
    if (outcome.kind === "unavailable") return reply.status(503).send({ error: "intake_unavailable" });
    if (outcome.kind === "failed") return reply.status(500).send({ error: "processing_failed" });
    if (outcome.kind === "duplicate") return reply.status(200).send({ ok: true, duplicate: true });
    return reply.status(200).send({ ok: true, applied: true });
  }

  if (!caps.WHATSAPP_NOTIFICATIONS) return reply.status(200).send({ ok: true, ignored: true });

  const outcome = await processConnectorDelivery(db, {
    tenantId, connectorId: connector.id, externalEventId: `whatsnexus:${event.eventId}`,
    direction: "inbound", payload: { type: "whatsnexus_status", status: event.status },
  }, false, (tx) => applyWhatsNexusStatus(tx, tenantId, {
    notificationId: event.externalId, wamid: event.wamid, status: event.status, at: event.occurredAt,
  }), (result) => result === "applied" ? undefined : result);
  if (outcome.kind === "failed") return reply.status(500).send({ error: "processing_failed" });
  if (outcome.kind === "duplicate") return reply.status(200).send({ ok: true, duplicate: true });
  if (outcome.kind === "processed" && outcome.value !== "applied") {
    return reply.status(200).send({ ok: true, applied: false, reason: outcome.value });
  }
  return reply.status(200).send({ ok: true, applied: true });
}

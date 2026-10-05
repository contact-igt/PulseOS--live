import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { markEventFailed, markEventProcessed, recordConnectorEvent } from "../connector/connector-event.service.js";
import { throttleAddress } from "../auth/login-throttle.js";
import { normalizePhone, resolveDefaultPhoneRegion } from "../patient/phone.js";
import { SlidingWindowLimiter } from "../../lib/rate-limiter.js";
import { processWebsiteFormSubmission } from "./website-form.service.js";

// Every field has a ceiling: this endpoint is public, so nothing a stranger sends may be unbounded.
const short = (max: number) => z.string().trim().max(max);
const opt = (max: number) => short(max).nullish();

const submissionBody = z.object({
  submissionId: short(100).min(1),
  formId: short(100).min(1),
  name: short(120).min(1),
  phone: short(20).min(1),
  email: z.string().trim().email().max(254).nullish(),
  service: opt(120),
  message: opt(1000),
  language: opt(40),
  branchId: z.string().uuid().nullish(),
  pageUrl: opt(500),
  utm: z.object({
    source: opt(200),
    medium: opt(200),
    campaign: opt(200),
    content: opt(200),
    term: opt(200),
  }).default({}),
  clickIds: z.object({
    gclid: opt(200),
    gbraid: opt(200),
    wbraid: opt(200),
    fbclid: opt(200),
  }).default({}),
});

/** What a hospital may configure on its website-form connector (non-secret, in `configuration`). */
interface IntakeConfig {
  /** The enquiry must name a service ("Cataract"). */
  requireService?: boolean;
  /** Always record this source (e.g. "website"), whatever the page's UTM tags say. */
  fixedSource?: "website";
  /** A browser request carrying an Origin that is not listed is refused. Requests with no Origin (server-to-server) are judged by the token alone. */
  allowedOrigins?: string[];
}

const readConfig = (raw: unknown): IntakeConfig => {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    requireService: c.requireService === true,
    fixedSource: c.fixedSource === "website" ? "website" : undefined,
    allowedOrigins: Array.isArray(c.allowedOrigins) ? c.allowedOrigins.filter((o): o is string => typeof o === "string").slice(0, 20) : undefined,
  };
};

/** Constant-time comparison of two secrets of any length (both are hashed to the same length first). */
function sameSecret(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

// PulseOS's own public landing-page/website form endpoint — not a
// third-party adapter, so it doesn't go through a provider registry.
// Tenant-safe the same way every other webhook route is: the connector id
// in the URL is the only source of tenant identity, never a value from the
// request body. Unauthenticated by session by design - the caller is the
// tenant's own website. A hospital that stores an `intakeToken` secret on the connector (Integration Hub) gets a closed door:
// the token goes in the `X-PulseOS-Intake-Token` header, added by the website's own server so it never ships in page JavaScript.
export async function websiteFormRoutes(app: FastifyInstance) {
  // Every request counts (accepted or not), so guessing tokens or flooding the form is throttled the same way.
  const limiter = new SlidingWindowLimiter(num(process.env.FORM_INTAKE_MAX_PER_MINUTE) ?? 20, 60_000);

  app.post("/forms/website/:connectorId", async (request, reply) => {
    const { connectorId } = request.params as { connectorId: string };
    if (!z.string().uuid().safeParse(connectorId).success) return reply.status(404).send({ error: "not_found" });

    const gate = limiter.hit(`${connectorId}:${throttleAddress(request.ip)}`);
    if (!gate.allowed) return reply.header("Retry-After", String(gate.retryAfterSeconds)).status(429).send({ error: "too_many_requests" });

    const connector = await getConnectorById(app.db, connectorId);
    if (!connector || connector.type !== "ACQUISITION" || connector.provider !== "website_form") {
      return reply.status(404).send({ error: "not_found" });
    }
    if (connector.status === "DISABLED") {
      return reply.status(403).send({ error: "connector_disabled" });
    }

    const config = readConfig(connector.configuration);
    const origin = request.headers.origin;
    if (config.allowedOrigins && config.allowedOrigins.length > 0 && typeof origin === "string" && !config.allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: "origin_not_allowed" });
    }

    const secrets = await getConnectorSecrets(app.db, connectorId);
    const expectedToken = typeof secrets?.intakeToken === "string" && secrets.intakeToken.length > 0 ? secrets.intakeToken : null;
    if (expectedToken) {
      const sent = request.headers["x-pulseos-intake-token"];
      if (typeof sent !== "string" || sent.length === 0 || !sameSecret(sent, expectedToken)) return reply.status(401).send({ error: "unauthorized" });
    }

    const parsed = submissionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ error: "invalid_request" });
    }
    const data = parsed.data;
    if (config.requireService && !data.service) return reply.status(422).send({ error: "invalid_request" });
    const region = await resolveDefaultPhoneRegion(app.db, connector.tenantId);
    if (!normalizePhone(data.phone, region).e164) return reply.status(422).send({ error: "invalid_request" });

    const { duplicate, eventId } = await recordConnectorEvent(app.db, {
      tenantId: connector.tenantId,
      connectorId,
      externalEventId: data.submissionId,
      direction: "inbound",
      payload: { type: "website_form", formId: data.formId },
    });
    if (duplicate) {
      return reply.status(200).send({ ok: true, duplicate: true });
    }

    try {
      const result = await processWebsiteFormSubmission(app.db, connector.tenantId, {
        formId: data.formId,
        name: data.name,
        phone: data.phone,
        email: data.email ?? null,
        service: data.service || null,
        message: data.message || null,
        language: data.language ?? null,
        branchId: data.branchId ?? null,
        pageUrl: data.pageUrl ?? null,
        submissionId: data.submissionId,
        fixedSource: config.fixedSource ?? null,
        utm: {
          source: data.utm.source ?? null,
          medium: data.utm.medium ?? null,
          campaign: data.utm.campaign ?? null,
          content: data.utm.content ?? null,
          term: data.utm.term ?? null,
        },
        clickIds: {
          gclid: data.clickIds.gclid ?? null,
          gbraid: data.clickIds.gbraid ?? null,
          wbraid: data.clickIds.wbraid ?? null,
          fbclid: data.clickIds.fbclid ?? null,
        },
        occurredAt: new Date(),
      });
      await markEventProcessed(app.db, eventId);
      await touchConnectorSuccess(app.db, connectorId);
      // A closed (token-protected) intake tells the caller only what it needs; internal ids stay inside.
      return reply.status(200).send(expectedToken ? { ok: true, duplicate: false, deduped: result.deduped } : { ok: true, duplicate: false, ...result });
    } catch (err) {
      await markEventFailed(app.db, eventId, (err as Error).message);
      await touchConnectorError(app.db, connectorId, (err as Error).message);
      return reply.status(500).send({ error: "processing_failed" });
    }
  });
}

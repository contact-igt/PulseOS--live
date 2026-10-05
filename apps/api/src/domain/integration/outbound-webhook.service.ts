import { randomBytes } from "node:crypto";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { outboundWebhookDeliveries, outboundWebhooks } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../security/encryption.js";
import { redactLogText } from "../security/redact.js";
import type { OutboundWebhookVm, TestWebhookInput, TestWebhookResult, WebhookCondition, WebhookEventType } from "@pulseos/types";
import type { IntegrationEvent } from "./domain-events.js";
import {
  WEBHOOK_MAX_ATTEMPTS,
  buildFullWebhookUrl,
  conditionsWellFormed,
  matchesConditions,
  nextAttemptDelayMs,
  resolveDynamicPayload,
  resolvesToPublicAddresses,
  signWebhookBody,
  validateWebhookUrl,
} from "./webhook-rules.js";
import type { z } from "zod";
import type { webhookInputSchema } from "./webhook-rules.js";

type Input = z.infer<typeof webhookInputSchema>;
type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

// A development/test escape hatch only: never honoured in production, whatever the environment says.
const allowInsecure = () => process.env.WEBHOOK_ALLOW_INSECURE === "true" && process.env.NODE_ENV !== "production";

function toVm(w: typeof outboundWebhooks.$inferSelect, last?: { at: Date | null; status: string | null }): OutboundWebhookVm {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    endpointPath: w.endpointPath ?? null,
    httpMethod: (w.httpMethod as OutboundWebhookVm["httpMethod"]) ?? "POST",
    headers: (w.headers as OutboundWebhookVm["headers"]) ?? [],
    payloadMapping: (w.payloadMapping as OutboundWebhookVm["payloadMapping"]) ?? [],
    webhookCategory: (w.webhookCategory as OutboundWebhookVm["webhookCategory"]) ?? "CUSTOM",
    events: w.events as WebhookEventType[],
    conditions: w.conditions as WebhookCondition[],
    enabled: w.enabled,
    hasSecret: true,
    createdAt: w.createdAt.toISOString(),
    lastDeliveryAt: last?.at?.toISOString() ?? null,
    lastDeliveryStatus: last?.status ?? null,
  };
}

export async function listWebhooks(db: Db, tenantId: string): Promise<OutboundWebhookVm[]> {
  const rows = await db.select().from(outboundWebhooks).where(eq(outboundWebhooks.tenantId, tenantId)).orderBy(outboundWebhooks.createdAt);
  const out: OutboundWebhookVm[] = [];
  for (const w of rows) {
    const [last] = await db
      .select({ at: outboundWebhookDeliveries.createdAt, status: outboundWebhookDeliveries.status })
      .from(outboundWebhookDeliveries)
      .where(eq(outboundWebhookDeliveries.webhookId, w.id))
      .orderBy(desc(outboundWebhookDeliveries.createdAt))
      .limit(1);
    out.push(toVm(w, last));
  }
  return out;
}

/** The signing secret is returned exactly once, here; afterwards only `hasSecret`. */
export async function createWebhook(db: Db, tenantId: string, actorId: string, input: Input): Promise<Result<{ webhook: OutboundWebhookVm; signingSecret: string }>> {
  const fullTarget = buildFullWebhookUrl(input.url, input.endpointPath);
  const url = validateWebhookUrl(fullTarget, { allowInsecure: allowInsecure() });
  if (!url.ok) return url;
  if (!conditionsWellFormed(input.conditions)) return { ok: false, reason: "invalid_conditions" };
  const signingSecret = "whsec_" + randomBytes(24).toString("hex");
  const [row] = await db
    .insert(outboundWebhooks)
    .values({
      tenantId,
      name: input.name,
      url: input.url.trim(),
      endpointPath: input.endpointPath?.trim() || null,
      httpMethod: input.httpMethod || "POST",
      headers: input.headers || [],
      payloadMapping: input.payloadMapping || [],
      webhookCategory: input.webhookCategory || "CUSTOM",
      events: input.events,
      conditions: input.conditions,
      enabled: input.enabled,
      encryptedSecret: encryptSecret({ signingSecret }),
      createdBy: actorId,
    })
    .returning();
  return { ok: true, webhook: toVm(row!), signingSecret };
}

export async function updateWebhook(db: Db, tenantId: string, id: string, input: Partial<Input>): Promise<Result<{ webhook: OutboundWebhookVm }>> {
  const [existing] = await db.select().from(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "webhook_not_found" };
  let url = existing.url;
  if (input.url !== undefined) {
    const fullTarget = buildFullWebhookUrl(input.url, input.endpointPath ?? existing.endpointPath);
    const v = validateWebhookUrl(fullTarget, { allowInsecure: allowInsecure() });
    if (!v.ok) return v;
    url = input.url.trim();
  }
  if (input.conditions && !conditionsWellFormed(input.conditions)) return { ok: false, reason: "invalid_conditions" };
  const [row] = await db
    .update(outboundWebhooks)
    .set({
      name: input.name ?? existing.name,
      url,
      endpointPath: input.endpointPath !== undefined ? (input.endpointPath?.trim() || null) : existing.endpointPath,
      httpMethod: input.httpMethod ?? existing.httpMethod,
      headers: input.headers ?? existing.headers,
      payloadMapping: input.payloadMapping ?? existing.payloadMapping,
      webhookCategory: input.webhookCategory ?? existing.webhookCategory,
      events: input.events ?? existing.events,
      conditions: input.conditions ?? existing.conditions,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: new Date(),
    })
    .where(eq(outboundWebhooks.id, id))
    .returning();
  return { ok: true, webhook: toVm(row!) };
}

export async function deleteWebhook(db: Db, tenantId: string, id: string): Promise<boolean> {
  const rows = await db.delete(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.id, id))).returning({ id: outboundWebhooks.id });
  return rows.length > 0;
}

/** Wire format every receiver sees. No tenant id, no secrets. */
export function webhookEnvelope(event: IntegrationEvent) {
  return { id: event.eventId, type: event.type, occurredAt: event.occurredAt.toISOString(), data: event.data };
}

/** Queue one delivery per matching enabled webhook. Idempotent: the same event never queues twice for one webhook. */
export async function enqueueWebhookDeliveries(db: Db, event: IntegrationEvent): Promise<number> {
  const hooks = await db.select().from(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, event.tenantId), eq(outboundWebhooks.enabled, true)));
  let queued = 0;
  for (const w of hooks) {
    if (!w.events.includes(event.type)) continue;
    if (!matchesConditions(w.conditions as WebhookCondition[], event.data)) continue;

    let payload: Record<string, unknown> = webhookEnvelope(event);
    const mappings = w.payloadMapping as Array<{ key: string; field: string; fallbackValue?: string | null }> | null;
    if (Array.isArray(mappings) && mappings.length > 0) {
      const context: Record<string, unknown> = {
        ...event.data,
        eventId: event.eventId,
        eventType: event.type,
        occurredAt: event.occurredAt.toISOString(),
        tenantId: event.tenantId,
      };
      payload = resolveDynamicPayload(mappings, context);
    }

    const rows = await db
      .insert(outboundWebhookDeliveries)
      .values({ tenantId: event.tenantId, webhookId: w.id, eventType: event.type, eventId: event.eventId, payload })
      .onConflictDoNothing()
      .returning({ id: outboundWebhookDeliveries.id });
    queued += rows.length;
  }
  return queued;
}

export type WebhookFetch = (url: string, init: { method: "POST" | "PUT" | string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "manual" }) => Promise<{ status: number }>;

const redact = (s: string) => redactLogText(s) ?? "failed";

/** Attempt every due delivery once. Bounded retries with backoff; a failing receiver never affects anything else. */
export async function deliverDueWebhooks(db: Db, now: Date, fetchImpl: WebhookFetch = fetch as unknown as WebhookFetch): Promise<{ sent: number; failed: number; retrying: number }> {
  const due = await db
    .select({ d: outboundWebhookDeliveries, w: outboundWebhooks })
    .from(outboundWebhookDeliveries)
    .innerJoin(outboundWebhooks, eq(outboundWebhooks.id, outboundWebhookDeliveries.webhookId))
    .where(and(eq(outboundWebhookDeliveries.status, "PENDING"), eq(outboundWebhooks.enabled, true), lte(outboundWebhookDeliveries.nextAttemptAt, now)))
    .limit(50);
  const tally = { sent: 0, failed: 0, retrying: 0 };
  for (const { d, w } of due) {
    // Claim before sending so a second worker (or a repeated tick) cannot send the same delivery twice.
    const claimed = await db
      .update(outboundWebhookDeliveries)
      .set({ attempts: sql`${outboundWebhookDeliveries.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 120_000) })
      .where(and(eq(outboundWebhookDeliveries.id, d.id), eq(outboundWebhookDeliveries.status, "PENDING"), lte(outboundWebhookDeliveries.nextAttemptAt, now)))
      .returning({ attempts: outboundWebhookDeliveries.attempts });
    if (claimed.length === 0) continue;
    const attempts = claimed[0]!.attempts;

    let status: number | null = null;
    let error: string | null = null;
    const targetUrl = buildFullWebhookUrl(w.url, w.endpointPath);
    const check = validateWebhookUrl(targetUrl, { allowInsecure: allowInsecure() });
    if (!check.ok) error = check.reason;
    // The address is validated at DELIVERY time too, against what the name resolves to now.
    else if (!allowInsecure() && !(await resolvesToPublicAddresses(new URL(check.url).hostname))) error = "private_address";
    else {
      try {
        const body = JSON.stringify(d.payload);
        const ts = String(Math.floor(now.getTime() / 1000));
        const secret = String(decryptSecret(w.encryptedSecret).signingSecret);

        const customHeaders: Record<string, string> = {};
        if (Array.isArray(w.headers)) {
          for (const h of w.headers as Array<{ key: string; value: string }>) {
            if (h.key && h.value) customHeaders[h.key] = h.value;
          }
        }

        const method = w.httpMethod || "POST";
        const res = await fetchImpl(check.url, {
          method,
          headers: {
            "content-type": "application/json",
            "x-pulseos-event": d.eventType,
            "x-pulseos-delivery": d.eventId,
            "x-pulseos-timestamp": ts,
            "x-pulseos-signature": signWebhookBody(secret, ts, body),
            ...customHeaders,
          },
          body,
          signal: AbortSignal.timeout(10000),
          // A redirect is never followed: it could point anywhere, including this network.
          redirect: "manual",
        });
        status = res.status;
        if (res.status >= 300 && res.status < 400) error = "redirect_refused";
        else if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (err) {
        error = redact(err instanceof Error ? err.message : String(err));
      }
    }

    if (!error) {
      await db.update(outboundWebhookDeliveries).set({ status: "SENT", responseStatus: status, error: null, deliveredAt: now }).where(eq(outboundWebhookDeliveries.id, d.id));
      tally.sent++;
      continue;
    }
    const delay = attempts >= WEBHOOK_MAX_ATTEMPTS ? null : nextAttemptDelayMs(attempts);
    if (delay === null) {
      await db.update(outboundWebhookDeliveries).set({ status: "FAILED", responseStatus: status, error }).where(eq(outboundWebhookDeliveries.id, d.id));
      tally.failed++;
    } else {
      await db.update(outboundWebhookDeliveries).set({ responseStatus: status, error, nextAttemptAt: new Date(now.getTime() + delay) }).where(eq(outboundWebhookDeliveries.id, d.id));
      tally.retrying++;
    }
  }
  return tally;
}

export async function testWebhookDelivery(
  tenantId: string,
  input: TestWebhookInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TestWebhookResult> {
  const fullTarget = buildFullWebhookUrl(input.url, input.endpointPath);
  const validated = validateWebhookUrl(fullTarget, { allowInsecure: allowInsecure() });
  if (!validated.ok) {
    return {
      ok: false,
      status: null,
      statusText: null,
      latencyMs: 0,
      requestUrl: fullTarget,
      requestMethod: input.httpMethod || "POST",
      requestHeaders: {},
      requestBody: "",
      error: `Invalid URL: ${validated.reason}`,
    };
  }

  const sampleContext: Record<string, unknown> = {
    call_Id: `call_test_${Date.now().toString(36)}`,
    journeyId: `jrn_test_${Date.now().toString(36)}`,
    customerName: "Ramesh Sharma",
    phoneNumber: "+919876543210",
    agentName: "Dr. Arvind Kumar",
    createdAt: new Date().toISOString(),
    status: "OPEN",
    typeOfEnquiry: "Follow-up Consultation",
    source: "PULSE_OS",
    templateName: "follow_up_reminder",
    message: "Dear Ramesh, your follow-up reminder from City Care Hospital is confirmed.",
    hospitalName: "City Care Hospital",
    eventType: "interaction.logged",
    ...(input.sampleContext ?? {}),
  };

  let payload: Record<string, unknown>;
  if (Array.isArray(input.payloadMapping) && input.payloadMapping.length > 0) {
    payload = resolveDynamicPayload(input.payloadMapping, sampleContext);
  } else {
    payload = {
      test: true,
      timestamp: new Date().toISOString(),
      event: "test.ping",
      data: sampleContext,
    };
  }

  const customHeaders: Record<string, string> = {};
  if (Array.isArray(input.headers)) {
    for (const h of input.headers) {
      if (h.key && h.value) customHeaders[h.key] = h.value;
    }
  }

  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    "x-pulseos-test": "true",
    ...customHeaders,
  };

  const bodyStr = JSON.stringify(payload, null, 2);
  const startTime = Date.now();
  try {
    const res = await fetchImpl(validated.url, {
      method: input.httpMethod || "POST",
      headers: requestHeaders,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
    const latencyMs = Date.now() - startTime;
    const text = await res.text();
    const isOk = res.status >= 200 && res.status < 300;
    return {
      ok: isOk,
      status: res.status,
      statusText: res.statusText || String(res.status),
      latencyMs,
      requestUrl: validated.url,
      requestMethod: input.httpMethod || "POST",
      requestHeaders,
      requestBody: bodyStr,
      responseBody: text.slice(0, 2000),
      error: isOk ? null : `HTTP ${res.status}: ${text.slice(0, 300)}`,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      ok: false,
      status: null,
      statusText: null,
      latencyMs,
      requestUrl: validated.url,
      requestMethod: input.httpMethod || "POST",
      requestHeaders,
      requestBody: bodyStr,
      error: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

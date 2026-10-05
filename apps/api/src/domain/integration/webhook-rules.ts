import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WEBHOOK_CONDITION_OPS, WEBHOOK_EVENT_TYPES, type WebhookCondition } from "@pulseos/types";
import { z } from "zod";

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export const webhookInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(500),
  endpointPath: z.string().trim().max(500).optional().nullable(),
  httpMethod: z.enum(["POST", "PUT", "GET", "PATCH"]).default("POST"),
  headers: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(100),
        value: z.string().trim().max(500),
      }),
    )
    .default([]),
  payloadMapping: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(100),
        field: z.string().trim().min(1).max(100),
        fallbackValue: z.string().trim().max(250).optional().nullable(),
      }),
    )
    .default([]),
  webhookCategory: z.enum(["CUSTOM", "WHATSNEXUS"]).default("CUSTOM"),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
  conditions: z
    .array(
      z.object({
        field: z.string().regex(FIELD),
        op: z.enum(WEBHOOK_CONDITION_OPS),
        value: z.union([z.string().max(120), z.array(z.string().max(120)).min(1).max(20)]),
      }),
    )
    .max(5)
    .default([]),
  enabled: z.boolean().default(true),
});

export function buildFullWebhookUrl(baseUrl: string, endpointPath?: string | null): string {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  if (!endpointPath || !endpointPath.trim()) return cleanBase;
  const cleanPath = endpointPath.trim().replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

export function resolveDynamicPayload(
  mapping: Array<{ key: string; field: string; fallbackValue?: string | null }>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedContext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    normalizedContext[k] = v;
    normalizedContext[k.toLowerCase()] = v;
    normalizedContext[k.replace(/[-_]/g, "").toLowerCase()] = v;
  }

  const ALIASES: Record<string, string[]> = {
    call_Id: ["call_Id", "callId", "call_id", "journeyId", "journey_id", "id", "eventId"],
    journeyId: ["journeyId", "journey_id", "id"],
    customerName: ["customerName", "patientName", "patient_name", "customer_name", "name"],
    phoneNumber: ["phoneNumber", "phone", "patientPhone", "patient_phone", "phoneE164", "phone_number"],
    agentName: ["agentName", "staffName", "staff_name", "doctorName", "doctor_name", "userName", "user_name"],
    createdAt: ["createdAt", "created_at", "occurredAt", "occurred_at", "date"],
    status: ["status", "stage", "journeyStatus"],
    typeOfEnquiry: ["typeOfEnquiry", "type_of_enquiry", "specialty", "department", "enquiryType"],
    source: ["source", "sourceKey", "source_key", "channel"],
    templateName: ["templateName", "template_name"],
    message: ["message", "messageText", "message_text", "body", "renderedText"],
    hospitalName: ["hospitalName", "hospital_name", "tenantName"],
    eventType: ["eventType", "event_type", "type"],
  };

  const payload: Record<string, unknown> = {};
  for (const item of mapping) {
    const targetKey = item.key.trim();
    if (!targetKey) continue;
    const selectedField = item.field.trim();
    let val: unknown = undefined;

    if (context[selectedField] !== undefined && context[selectedField] !== null) {
      val = context[selectedField];
    } else if (normalizedContext[selectedField.toLowerCase()] !== undefined && normalizedContext[selectedField.toLowerCase()] !== null) {
      val = normalizedContext[selectedField.toLowerCase()];
    } else {
      const aliases = ALIASES[selectedField] ?? ALIASES[targetKey] ?? [];
      for (const alias of aliases) {
        const found = normalizedContext[alias.toLowerCase()] ?? normalizedContext[alias.replace(/[-_]/g, "").toLowerCase()];
        if (found !== undefined && found !== null) {
          val = found;
          break;
        }
      }
    }

    if (val === undefined || val === null || val === "") {
      payload[targetKey] = item.fallbackValue ?? null;
    } else {
      payload[targetKey] = val;
    }
  }
  return payload;
}

/** `in` needs a list; `eq`/`neq` need a single value. Anything else is refused rather than guessed at. */
export function conditionsWellFormed(conditions: WebhookCondition[]): boolean {
  return conditions.every((c) => (c.op === "in" ? Array.isArray(c.value) : typeof c.value === "string"));
}

/** Simple structured comparison only: every condition must hold. A field the event does not carry never matches. */
export function matchesConditions(conditions: WebhookCondition[], data: Record<string, string | number | boolean | null>): boolean {
  return conditions.every((c) => {
    const actual = data[c.field];
    if (actual === undefined || actual === null) return c.op === "neq";
    const s = String(actual);
    if (c.op === "eq") return s === c.value;
    if (c.op === "neq") return s !== c.value;
    return Array.isArray(c.value) && c.value.includes(s);
  });
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    const c = Number(h.split(".")[2]);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224; // IETF protocol, benchmarking, multicast/reserved
  }
  if (kind === 6) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:") || h.startsWith("64:ff9b:") || h.startsWith("2002:") || h.startsWith("ff");
  return false;
}

export { isPrivateHost };

/** Every address a hostname resolves to must be public (a public NAME that points at 127.0.0.1 or the metadata address is refused). */
export async function resolvesToPublicAddresses(host: string, lookup: (h: string) => Promise<{ address: string }[]> = (h) => dnsLookup(h, { all: true })): Promise<boolean> {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return !isPrivateHost(host);
  try {
    const addrs = await lookup(host);
    return addrs.length > 0 && addrs.every((a) => !isPrivateHost(a.address));
  } catch {
    return false;
  }
}

/** HTTPS to a public host only (a webhook must never be a way to reach the hospital's own network). */
export function validateWebhookUrl(raw: string, opts: { allowInsecure?: boolean } = {}): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials_in_url" };
  if (opts.allowInsecure) return { ok: true, url: u.toString() };
  if (u.protocol !== "https:") return { ok: false, reason: "https_required" };
  if (isPrivateHost(u.hostname)) return { ok: false, reason: "private_address" };
  return { ok: true, url: u.toString() };
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookBody(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** 1m, 5m, 30m then give up: bounded, never an endless retry against someone else's server. */
export const WEBHOOK_MAX_ATTEMPTS = 4;
export function nextAttemptDelayMs(attemptsSoFar: number): number | null {
  return [60_000, 300_000, 1_800_000][attemptsSoFar - 1] ?? null;
}

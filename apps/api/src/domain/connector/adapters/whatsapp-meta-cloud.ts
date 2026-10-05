import { META_GRAPH_API_VERSION, verifyMetaChallenge, verifyMetaSignature } from "../meta-webhook.js";
import { AmbiguousSendError, type MessagingProviderAdapter, type ParsedWhatsAppWebhook } from "../types.js";

// Ported patterns from invictus-chatbot's AuthWhatsApp controller/service (read
// fully, reference-only): the GET challenge check (hub.mode/hub.verify_token/
// hub.challenge), the atomic-dedupe-on-wamid idea (we use the shared
// connector_events unique index instead of a bespoke table), and the Graph
// API outbound call shape (POST .../{phone_number_id}/messages, Bearer
// token, response.messages[0].id is the wamid). HMAC signature verification
// was NOT present in that reference implementation — added here per Meta's
// own documented webhook security contract, since PulseOS must not accept
// unsigned webhook traffic. Challenge/signature verification now shared
// with the Meta Lead Ads adapter via meta-webhook.ts, rather than each
// Meta-family adapter re-implementing the same HMAC check.

interface MetaWebhookValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: { id: string; from: string; timestamp: string; type: string; text?: { body?: string } }[];
  statuses?: { id: string; status: string; timestamp: string }[];
}

export const whatsAppMetaCloudAdapter: MessagingProviderAdapter = {
  capabilities: ["SEND_MESSAGE", "RECEIVE_MESSAGE", "RECEIVE_STATUS"],

  verifyWebhookChallenge(query, secrets) {
    return verifyMetaChallenge(query, secrets.webhookVerifyToken);
  },

  verifyWebhookSignature(rawBody, signatureHeader, secrets) {
    return verifyMetaSignature(rawBody, signatureHeader, secrets.appSecret);
  },

  parseWebhookPayload(payload): ParsedWhatsAppWebhook {
    const result: ParsedWhatsAppWebhook = { messages: [], statuses: [] };
    const body = payload as { entry?: { changes?: { value?: MetaWebhookValue }[] }[] };
    const entries = body.entry ?? [];

    for (const entry of entries) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const contactByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

        for (const msg of value.messages ?? []) {
          const bodyText = msg.type === "text" ? (msg.text?.body ?? "") : `[unsupported message type: ${msg.type}]`;
          result.messages.push({
            externalEventId: msg.id,
            externalThreadId: msg.from,
            fromPhone: msg.from,
            fromName: contactByWaId.get(msg.from) ?? null,
            body: bodyText,
            occurredAt: new Date(Number(msg.timestamp) * 1000),
            phoneNumberId: value.metadata?.phone_number_id ?? null,
          });
        }

        for (const status of value.statuses ?? []) {
          if (status.status !== "sent" && status.status !== "delivered" && status.status !== "read" && status.status !== "failed") continue;
          result.statuses.push({
            externalEventId: `${status.id}:${status.status}`,
            providerMessageId: status.id,
            status: status.status,
            occurredAt: new Date(Number(status.timestamp) * 1000),
          });
        }
      }
    }

    return result;
  },

  async sendMessage(config, secrets, to, body) {
    if (config.mode === "fixture") {
      // No live Meta credentials in local dev — this is a genuinely usable,
      // deterministic stand-in for the Graph API response shape, never
      // presented as a real delivered message. Embeds the phoneNumberId it
      // was actually given (falling back to the connector default the same
      // way the real branch below reads config.phoneNumberId) so a test can
      // prove which line a fixture "send" would have used, without needing
      // a live Graph API call.
      const phoneNumberId = typeof config.phoneNumberId === "string" ? config.phoneNumberId : "unknown";
      return { providerMessageId: `FIXTURE_WAMID_${phoneNumberId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    }

    const phoneNumberId = config.phoneNumberId;
    const accessToken = secrets.accessToken;
    if (typeof phoneNumberId !== "string" || typeof accessToken !== "string") {
      throw new Error("WhatsApp connector is missing phoneNumberId configuration or accessToken secret");
    }

    const res = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      throw new Error(`WhatsApp send failed: ${res.status} ${errorBody}`);
    }

    const data = (await res.json()) as { messages?: { id?: string }[] };
    const providerMessageId = data.messages?.[0]?.id;
    if (!providerMessageId) throw new Error("WhatsApp send succeeded but returned no message id");
    return { providerMessageId };
  },

  async sendTemplate(config, secrets, to, template) {
    if (config.mode === "fixture") {
      // Deterministic stand-in, never a real send. Same id shape as sendMessage's fixture so delivery tests can match it.
      const phoneNumberId = typeof config.phoneNumberId === "string" ? config.phoneNumberId : "unknown";
      return { providerMessageId: `FIXTURE_WAMID_${phoneNumberId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
    }
    const phoneNumberId = config.phoneNumberId;
    const accessToken = secrets.accessToken;
    if (typeof phoneNumberId !== "string" || typeof accessToken !== "string") {
      throw new Error("WhatsApp connector is missing phoneNumberId configuration or accessToken secret");
    }
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      // A hung provider must not hold a message in PROCESSING until another worker reclaims (and re-sends) it.
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: template.parameters.length ? [{ type: "body", parameters: template.parameters.map((text) => ({ type: "text", text })) }] : [],
        },
      }),
      });
    } catch (err) {
      // An aborted request may have been accepted by the provider after we stopped waiting.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw new AmbiguousSendError("WhatsApp send timed out; delivery unknown");
      throw err;
    }
    if (!res.ok) {
      // Status only: the provider's error body can echo request details, and nothing credential-shaped may reach a log.
      throw new Error(`WhatsApp template send failed: HTTP ${res.status}`);
    }
    let data: { messages?: { id?: string }[] };
    try {
      data = (await res.json()) as { messages?: { id?: string }[] };
    } catch {
      throw new AmbiguousSendError("WhatsApp send accepted but the response was unreadable");
    }
    const providerMessageId = data.messages?.[0]?.id;
    if (!providerMessageId) throw new AmbiguousSendError("WhatsApp send succeeded but returned no message id");
    return { providerMessageId };
  },
};

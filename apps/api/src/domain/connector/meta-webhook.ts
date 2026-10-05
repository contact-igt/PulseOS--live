import { createHmac, timingSafeEqual } from "node:crypto";

// v23.0 (previously hard-coded per-adapter) reached end-of-life and no
// longer works; v25.0 verified current. Shared by every Meta-family adapter
// (WhatsApp Cloud API, Meta Lead Ads) so there is exactly one place to bump
// this again.
export const META_GRAPH_API_VERSION = "v25.0";

// Meta's webhook subscription verification handshake (GET with hub.mode/
// hub.verify_token/hub.challenge) is identical across every Meta webhook
// product — WhatsApp, Lead Ads, Messenger. One implementation, reused.
export function verifyMetaChallenge(query: Record<string, string>, verifyToken: unknown): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || !token || !challenge) return null;
  if (typeof verifyToken !== "string" || token !== verifyToken) return null;
  return challenge;
}

// X-Hub-Signature-256, computed over the exact raw request bytes with the
// app secret — also identical across every Meta webhook product.
export function verifyMetaSignature(rawBody: string, signatureHeader: string | undefined, appSecret: unknown): boolean {
  if (typeof appSecret !== "string" || !appSecret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const providedHex = signatureHeader.slice("sha256=".length);
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "../domain/integration/webhook-rules.js";
import { CALLBACK_TOLERANCE_SECONDS, verifyWhatsNexusCallback } from "../domain/connector/whatsnexus-callback.js";

/**
 * The WhatsNexus ↔ PulseOS callback signature contract, pinned by a GOLDEN VECTOR that the WhatsNexus repo asserts too
 * (tests/pulseos.unit.test.js). If either side's signing changes, one of the two suites fails.
 *
 *   x-whatsnexus-signature = "sha256=" + hex(HMAC_SHA256(secret, `${x-whatsnexus-timestamp}.${exact raw body}`))
 */
const GOLDEN = {
  secret: "contract-secret-0123456789",
  timestamp: "1700000000",
  body: JSON.stringify({ eventId: "d1:delivered", externalId: "5b0e6f0e-0a55-4a39-9d3f-7e7f5a0c1d11", status: "delivered" }),
  signature: "sha256=0ff2ac86e180c65a62acaf4d1feebf267e16fd888ea167e32e154454f2307439",
};

describe("callback signature contract (PulseOS side)", () => {
  it("PulseOS produces and accepts the golden vector", () => {
    expect(signWebhookBody(GOLDEN.secret, GOLDEN.timestamp, GOLDEN.body)).toBe(GOLDEN.signature);
    expect(verifyWebhookSignature(GOLDEN.secret, GOLDEN.timestamp, GOLDEN.body, GOLDEN.signature)).toBe(true);
    expect(verifyWhatsNexusCallback({ callbackSecret: GOLDEN.secret }, GOLDEN.body, GOLDEN.timestamp, GOLDEN.signature, Number(GOLDEN.timestamp) * 1000)).toBe("ok");
  });
  it("is plain HMAC-SHA256 over `timestamp.rawBody` with a `sha256=` hex prefix (independent re-computation)", () => {
    const hex = createHmac("sha256", GOLDEN.secret).update(`${GOLDEN.timestamp}.${GOLDEN.body}`).digest("hex");
    expect(GOLDEN.signature).toBe(`sha256=${hex}`);
  });
  it("the freshness window is 5 minutes in both directions", () => {
    expect(CALLBACK_TOLERANCE_SECONDS).toBe(300);
    const now = Number(GOLDEN.timestamp) * 1000;
    const s = { callbackSecret: GOLDEN.secret };
    expect(verifyWhatsNexusCallback(s, GOLDEN.body, GOLDEN.timestamp, GOLDEN.signature, now + 299_000)).toBe("ok");
    expect(verifyWhatsNexusCallback(s, GOLDEN.body, GOLDEN.timestamp, GOLDEN.signature, now + 301_000)).toBe("stale");
    expect(verifyWhatsNexusCallback(s, GOLDEN.body, GOLDEN.timestamp, GOLDEN.signature, now - 301_000)).toBe("stale");
  });
});

// Live cross-check against the WhatsNexus implementation itself, when its repository is available.
const wnRoot = process.env.WN_E2E_ROOT ?? "C:/Invictus_Projects/Whatsnexus/invictus-chatbot";
const wnCrypto = path.join(wnRoot, "src/models/IntegrationModel/pulseos.crypto.js");
describe.skipIf(!existsSync(wnCrypto))("callback signature contract (against the real WhatsNexus module)", () => {
  it("WhatsNexus signs exactly what PulseOS verifies — golden and random vectors, both directions", async () => {
    const wn = (await import(/* @vite-ignore */ pathToFileURL(wnCrypto).href)) as {
      signCallbackBody: (s: string, t: string, b: string) => string;
      verifyCallbackSignature: (s: string, t: string, b: string, sig: string) => boolean;
    };
    expect(wn.signCallbackBody(GOLDEN.secret, GOLDEN.timestamp, GOLDEN.body)).toBe(GOLDEN.signature);
    for (let i = 0; i < 25; i++) {
      const secret = `whcs_${randomBytes(24).toString("base64url")}`;
      const ts = String(1_760_000_000 + i);
      const body = JSON.stringify({ i, text: "ünïcode ✓ \n \"quotes\"", nested: { a: [1, 2, 3] }, id: randomBytes(8).toString("hex") });
      const fromWn = wn.signCallbackBody(secret, ts, body);
      const fromPo = signWebhookBody(secret, ts, body);
      expect(fromWn).toBe(fromPo);
      expect(verifyWebhookSignature(secret, ts, body, fromWn)).toBe(true); // PulseOS accepts what WhatsNexus signed
      expect(wn.verifyCallbackSignature(secret, ts, body, fromPo)).toBe(true); // and vice versa
      expect(verifyWhatsNexusCallback({ callbackSecret: secret }, body, ts, fromWn, Number(ts) * 1000)).toBe("ok");
    }
  });
  it("the header names and the signed header set match between the two code bases", () => {
    const wnSource = readFileSync(path.join(wnRoot, "src/models/IntegrationModel/pulseos.callback.service.js"), "utf8");
    for (const h of ["x-whatsnexus-timestamp", "x-whatsnexus-signature", "x-whatsnexus-event-id"]) expect(wnSource).toContain(h);
    const poSource = readFileSync(path.join(__dirname, "..", "domain", "connector", "webhook.routes.ts"), "utf8");
    for (const h of ["x-whatsnexus-timestamp", "x-whatsnexus-signature"]) expect(poSource).toContain(h);
  });
});

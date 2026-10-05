import { describe, expect, it } from "vitest";
import { matchesConditions, nextAttemptDelayMs, signWebhookBody, validateWebhookUrl, verifyWebhookSignature, webhookInputSchema } from "../domain/integration/webhook-rules.js";

describe("outbound webhook rules", () => {
  it("evaluates simple structured conditions (all must hold)", () => {
    const data = { sourceKey: "google", departmentId: "d1" };
    expect(matchesConditions([{ field: "sourceKey", op: "eq", value: "google" }], data)).toBe(true);
    expect(matchesConditions([{ field: "sourceKey", op: "in", value: ["meta", "google"] }, { field: "departmentId", op: "neq", value: "d2" }], data)).toBe(true);
    expect(matchesConditions([{ field: "sourceKey", op: "eq", value: "meta" }], data)).toBe(false);
    expect(matchesConditions([{ field: "missing", op: "eq", value: "x" }], data)).toBe(false);
    expect(matchesConditions([], data)).toBe(true);
  });

  it("refuses unknown events and malformed conditions (no scripting surface)", () => {
    const base = { name: "n", url: "https://example.org/h", events: ["lead.created"] };
    expect(webhookInputSchema.safeParse(base).success).toBe(true);
    expect(webhookInputSchema.safeParse({ ...base, events: ["patient.deleted"] }).success).toBe(false);
    expect(webhookInputSchema.safeParse({ ...base, conditions: [{ field: "a.b", op: "eq", value: "x" }] }).success).toBe(false);
    expect(webhookInputSchema.safeParse({ ...base, conditions: [{ field: "a", op: "matches", value: "x" }] }).success).toBe(false);
  });

  it("only allows https to public hosts", () => {
    expect(validateWebhookUrl("https://hooks.example.org/x").ok).toBe(true);
    for (const bad of ["http://hooks.example.org/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://169.254.169.254/x", "https://192.168.0.5/x", "https://[::1]/x", "https://u:p@example.org/x", "not a url"]) {
      expect(validateWebhookUrl(bad).ok, bad).toBe(false);
    }
  });

  it("signs the timestamped body and verifies it constant-time", () => {
    const sig = signWebhookBody("s3cret", "1700000000", '{"a":1}');
    expect(verifyWebhookSignature("s3cret", "1700000000", '{"a":1}', sig)).toBe(true);
    expect(verifyWebhookSignature("s3cret", "1700000001", '{"a":1}', sig)).toBe(false);
    expect(verifyWebhookSignature("other", "1700000000", '{"a":1}', sig)).toBe(false);
  });

  it("retries a bounded number of times", () => {
    expect([1, 2, 3, 4].map(nextAttemptDelayMs)).toEqual([60_000, 300_000, 1_800_000, null]);
  });
});

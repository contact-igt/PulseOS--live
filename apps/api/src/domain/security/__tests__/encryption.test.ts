import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../encryption.js";

describe("connector secret encryption", () => {
  // Self-contained rather than relying on ambient `.env` loading — `pnpm dev`
  // loads apps/api/.env, but a bare `vitest run` does not, which otherwise
  // makes this suite fail outside the dev-server process.
  beforeAll(() => {
    process.env.CONNECTOR_ENCRYPTION_KEY ??= "test-only-not-a-real-secret-key";
  });

  it("round-trips a JSON secret payload", () => {
    const payload = { accessToken: "EAA...fixture", webhookVerifyToken: "verify-me" };
    const encrypted = encryptSecret(payload);
    expect(encrypted).not.toContain("EAA...fixture");
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toEqual(payload);
  });

  it("produces different ciphertext for the same payload on each call (random IV)", () => {
    const payload = { accessToken: "same-value" };
    const a = encryptSecret(payload);
    const b = encryptSecret(payload);
    expect(a).not.toBe(b);
  });

  it("throws on tampered ciphertext instead of silently returning wrong data", () => {
    const encrypted = encryptSecret({ accessToken: "x" });
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

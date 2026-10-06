import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EncryptionNotConfiguredError, SecretsUnreadableError, decryptSecret, encryptSecret, encryptionStartupWarning, isEncryptionConfigured, secretErrorCode } from "../encryption.js";

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

// The Railway "Could not save: internal_error" regression: with CONNECTOR_ENCRYPTION_KEY unset the save used to die as an
// anonymous 500. The failure is now typed so the API can answer with a safe, specific code (never the key, never a stack).
describe("connector secret encryption — failure modes", () => {
  const original = process.env.CONNECTOR_ENCRYPTION_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = original;
  });

  it("reports whether an encryption key is configured", () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = "some-key";
    expect(isEncryptionConfigured()).toBe(true);
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    process.env.CONNECTOR_ENCRYPTION_KEY = "   ";
    expect(isEncryptionConfigured()).toBe(false);
  });

  it("a missing key is a typed EncryptionNotConfiguredError on encrypt and decrypt", () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = "k1";
    const stored = encryptSecret({ apiKey: "synthetic" });
    delete process.env.CONNECTOR_ENCRYPTION_KEY;
    expect(() => encryptSecret({ apiKey: "x" })).toThrow(EncryptionNotConfiguredError);
    expect(() => decryptSecret(stored)).toThrow(EncryptionNotConfiguredError);
  });

  it("a payload sealed under a different key is a typed SecretsUnreadableError, not a raw crypto error", () => {
    process.env.CONNECTOR_ENCRYPTION_KEY = "key-one";
    const stored = encryptSecret({ apiKey: "synthetic" });
    process.env.CONNECTOR_ENCRYPTION_KEY = "key-two";
    expect(() => decryptSecret(stored)).toThrow(SecretsUnreadableError);
    expect(() => decryptSecret("not-base64-at-all")).toThrow(SecretsUnreadableError);
  });

  it("maps secret-storage failures to a safe response and leaves every other error alone", () => {
    expect(secretErrorCode(new EncryptionNotConfiguredError())).toBe("encryption_not_configured");
    expect(secretErrorCode(new SecretsUnreadableError())).toBe("secrets_unreadable");
    expect(secretErrorCode(new Error("Failed query: select ..."))).toBeNull();
    expect(new EncryptionNotConfiguredError().message).not.toMatch(/\bkey=|secret=/i);
  });

  it("warns at startup when the key is missing or blank, and stays quiet when it is set; the warning never contains a value", () => {
    expect(encryptionStartupWarning({})).toMatch(/CONNECTOR_ENCRYPTION_KEY is not set/);
    expect(encryptionStartupWarning({ CONNECTOR_ENCRYPTION_KEY: "  " })).toMatch(/not set/);
    expect(encryptionStartupWarning({ CONNECTOR_ENCRYPTION_KEY: "synthetic-value" })).toBeNull();
  });
});

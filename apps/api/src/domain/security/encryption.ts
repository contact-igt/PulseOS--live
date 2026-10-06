import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Connector secrets (access tokens, webhook verify tokens, app secrets) are the only
// place PulseOS stores third-party credentials. They are never placed on the general
// connector row — only inside this encrypted boundary, decrypted in memory at the
// point of use and never logged.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Typed so the API can answer with a safe, specific code instead of an anonymous 500. Messages never carry key material.
export class EncryptionNotConfiguredError extends Error {
  readonly code = "encryption_not_configured";
  constructor() {
    super("CONNECTOR_ENCRYPTION_KEY env var is required to encrypt or decrypt connector secrets");
  }
}

/** Stored secrets exist but cannot be opened: the key changed since they were saved, or the payload is damaged. */
export class SecretsUnreadableError extends Error {
  readonly code = "secrets_unreadable";
  constructor() {
    super("Stored connector secrets cannot be decrypted with the configured CONNECTOR_ENCRYPTION_KEY");
  }
}

/** The error code to send to the browser for a secret-storage failure, or null for any other error. */
export function secretErrorCode(error: unknown): "encryption_not_configured" | "secrets_unreadable" | null {
  if (error instanceof EncryptionNotConfiguredError) return "encryption_not_configured";
  if (error instanceof SecretsUnreadableError) return "secrets_unreadable";
  return null;
}

/**
 * Logged once at startup. The API still boots without a key (connectors may be unused), but every operation that reads or
 * writes connector credentials will fail, so say so loudly instead of leaving it to the first failed Save.
 */
export function encryptionStartupWarning(env: Record<string, string | undefined> = process.env): string | null {
  if (env.CONNECTOR_ENCRYPTION_KEY?.trim()) return null;
  return "CONNECTOR_ENCRYPTION_KEY is not set: saving or reading connector credentials (CCS, Runo, WhatsApp, ads, webhooks) will fail until it is configured. " +
    "Use the value that already protects stored credentials; a different value makes them unreadable.";
}

export function isEncryptionConfigured(): boolean {
  return !!process.env.CONNECTOR_ENCRYPTION_KEY?.trim();
}

function resolveKey(): Buffer {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) throw new EncryptionNotConfiguredError();
  // Accept any non-empty passphrase locally; derive a fixed-length key via SHA-256
  // rather than requiring operators to hand-generate exactly 32 random bytes.
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(payload: Record<string, unknown>): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encrypted: string): Record<string, unknown> {
  const key = resolveKey();
  try {
    const raw = Buffer.from(encrypted, "base64");
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = raw.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    // Wrong key, truncated or tampered data: one typed failure, no crypto internals.
    throw new SecretsUnreadableError();
  }
}

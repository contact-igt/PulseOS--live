import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Connector secrets (access tokens, webhook verify tokens, app secrets) are the only
// place PulseOS stores third-party credentials. They are never placed on the general
// connector row — only inside this encrypted boundary, decrypted in memory at the
// point of use and never logged.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function resolveKey(): Buffer {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!raw) throw new Error("CONNECTOR_ENCRYPTION_KEY env var is required to encrypt or decrypt connector secrets");
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
  const raw = Buffer.from(encrypted, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

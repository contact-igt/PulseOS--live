import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function platformMfaKey() {
  const value = process.env.PLATFORM_MFA_KEY;
  return value && /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : null;
}

export function newMfaSecret(key: Buffer) {
  const secret = randomBytes(20);
  let setupKey = "";
  for (let i = 0; i < 160; i += 5) {
    const offset = i % 8;
    const first = secret[Math.floor(i / 8)]!;
    const next = secret[Math.floor(i / 8) + 1] ?? 0;
    setupKey += alphabet[((first << 8 | next) >> (11 - offset)) & 31];
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { setupKey, encrypted: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url") };
}

export function verifyMfa(key: Buffer, encrypted: string, code: string, lastStep: number | null) {
  const value = Buffer.from(encrypted, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  const secret = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
  const current = Math.floor(Date.now() / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = createHmac("sha1", secret).update(counter).digest();
    const offset = mac[mac.length - 1]! & 15;
    const expected = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return step;
  }
  return null;
}

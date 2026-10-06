import { decryptSecret, secretErrorCode } from "../security/encryption.js";

export interface SecretFacts {
  /** NAMES of the stored secrets that hold a value. Never a value. */
  keys: string[];
  /** A payload is stored but cannot be opened (key missing or changed). Not the same as "nothing saved". */
  unreadable: boolean;
  /** Why it cannot be opened, as the typed code the API answers with. */
  reason: "encryption_not_configured" | "secrets_unreadable" | null;
}

/** What is stored for a connector, safely: a failure to decrypt becomes a fact, not an exception. */
export function readSecretFacts(encryptedPayload: string | null | undefined): SecretFacts {
  if (!encryptedPayload) return { keys: [], unreadable: false, reason: null };
  try {
    const keys = Object.entries(decryptSecret(encryptedPayload)).filter(([, v]) => v !== "" && v != null).map(([k]) => k);
    return { keys, unreadable: false, reason: null };
  } catch (err) {
    const reason = secretErrorCode(err);
    if (!reason) throw err; // not a secret-storage problem: let it surface
    return { keys: [], unreadable: true, reason };
  }
}

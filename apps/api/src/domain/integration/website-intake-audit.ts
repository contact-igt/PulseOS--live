import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectors, connectorSecrets } from "../../db/schema.js";
import { decryptSecret } from "../security/encryption.js";

// Read-only operator checks. They report identifiers and kinds only: never a secret, a hospital name or anything a visitor sent.

export interface OpenIntake {
  tenantId: string;
  connectorId: string;
  status: string;
  mode: string;
  /** no_token: nothing protects it. token_unreadable: a token is stored but cannot be decrypted with the configured key, so it cannot be checked either. */
  reason: "no_token" | "token_unreadable";
}

/**
 * Website intakes that are not switched off and are not protected by a readable token. An older API release (which ignores the
 * `requireToken` setting) would accept anyone on these, so this must be empty before rolling the API back.
 */
export async function findOpenWebsiteIntakes(db: Db): Promise<OpenIntake[]> {
  const rows = await db.select().from(connectors).where(and(eq(connectors.provider, "website_form"), ne(connectors.status, "DISABLED")));
  const out: OpenIntake[] = [];
  for (const c of rows) {
    const [secret] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c.id)).limit(1);
    let reason: OpenIntake["reason"] | null = "no_token";
    if (secret) {
      try {
        const token = decryptSecret(secret.encryptedPayload).intakeToken;
        reason = typeof token === "string" && token.length > 0 ? null : "no_token";
      } catch {
        reason = "token_unreadable";
      }
    }
    if (reason) out.push({ tenantId: c.tenantId, connectorId: c.id, status: c.status, mode: c.mode, reason });
  }
  return out;
}

export interface SecretsCheck {
  total: number;
  ok: number;
  failed: { connectorId: string; tenantId: string; provider: string }[];
}

/**
 * Whether every stored connector secret can still be decrypted with the configured CONNECTOR_ENCRYPTION_KEY. Proves key continuity
 * after a deploy or a rollback without ever showing a key or a secret.
 */
export async function checkSecretsDecryptable(db: Db): Promise<SecretsCheck> {
  const rows = await db
    .select({ connectorId: connectorSecrets.connectorId, payload: connectorSecrets.encryptedPayload, tenantId: connectors.tenantId, provider: connectors.provider })
    .from(connectorSecrets)
    .innerJoin(connectors, eq(connectors.id, connectorSecrets.connectorId));
  const failed: SecretsCheck["failed"] = [];
  let ok = 0;
  for (const r of rows) {
    try {
      decryptSecret(r.payload);
      ok++;
    } catch {
      failed.push({ connectorId: r.connectorId, tenantId: r.tenantId, provider: r.provider });
    }
  }
  return { total: rows.length, ok, failed };
}

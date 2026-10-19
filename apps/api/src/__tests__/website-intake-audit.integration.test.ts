import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { connectorSecrets, connectors } from "../db/schema.js";
import { encryptSecret } from "../domain/security/encryption.js";
import { checkSecretsDecryptable, findOpenWebsiteIntakes } from "../domain/integration/website-intake-audit.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The checks to run BEFORE rolling the API back to a release that ignores `requireToken`, and to confirm key continuity after a
// deploy: which enabled website intakes would accept anyone, and whether every stored secret can still be read. Output carries ids
// and names of kinds only, never a secret or anything a visitor sent.
describe.skipIf(!DEMO_PASSWORD)("website intake rollback / key-continuity audit (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  const made: string[] = [];

  const connector = async (status: "CONNECTED" | "DISABLED" | "CONNECTING" | "ERROR", provider = "website_form", token?: string | null) => {
    const [c] = await db.insert(connectors).values({ tenantId: t.tenantId, type: "ACQUISITION", provider: `${provider}`, status, mode: "LIVE", displayName: "audit fixture", capabilities: ["RECEIVE_FORM"], configuration: {} }).returning();
    made.push(c!.id);
    if (token !== undefined) await db.insert(connectorSecrets).values({ connectorId: c!.id, encryptedPayload: token === null ? "not-a-valid-payload" : encryptSecret({ intakeToken: token }) });
    return c!;
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
  });
  afterAll(async () => {
    for (const id of made) await db.delete(connectorSecrets).where(eq(connectorSecrets.connectorId, id));
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("lists enabled website intakes that have no token or whose token cannot be read, and nothing else", async () => {
    // One website_form per tenant: use separate throwaway tenants for each shape.
    const shapes: { label: string; status: "CONNECTED" | "DISABLED" | "CONNECTING" | "ERROR"; token?: string | null }[] = [
      { label: "open", status: "CONNECTED" },
      { label: "open-connecting", status: "CONNECTING" },
      { label: "open-error", status: "ERROR" },
      { label: "protected", status: "CONNECTED", token: "tok-protected-1234567890" },
      { label: "held-closed", status: "DISABLED" },
      { label: "unreadable", status: "CONNECTED", token: null },
    ];
    const tenants: TestTenant[] = [];
    const ids = new Map<string, string>();
    try {
      for (const sh of shapes) {
        const x = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
        tenants.push(x);
        const [c] = await db.insert(connectors).values({ tenantId: x.tenantId, type: "ACQUISITION", provider: "website_form", status: sh.status, mode: "LIVE", displayName: sh.label, capabilities: ["RECEIVE_FORM"], configuration: {} }).returning();
        ids.set(sh.label, c!.id);
        if (sh.token !== undefined) await db.insert(connectorSecrets).values({ connectorId: c!.id, encryptedPayload: sh.token === null ? "not-a-valid-payload" : encryptSecret({ intakeToken: sh.token }) });
      }
      const found = await findOpenWebsiteIntakes(db);
      const mine = found.filter((f) => [...ids.values()].includes(f.connectorId));
      const byReason = Object.fromEntries(mine.map((m) => [[...ids].find(([, id]) => id === m.connectorId)![0], m.reason]));
      expect(byReason).toEqual({ open: "no_token", "open-connecting": "no_token", "open-error": "no_token", unreadable: "token_unreadable" });
      // Only identifiers and kinds: no secret, name or payload.
      for (const m of mine) expect(Object.keys(m).sort()).toEqual(["connectorId", "mode", "reason", "status", "tenantId"]);
      expect(JSON.stringify(mine)).not.toContain("tok-protected");
    } finally {
      for (const x of tenants) {
        for (const id of ids.values()) await db.delete(connectorSecrets).where(eq(connectorSecrets.connectorId, id));
        await destroyTestTenant(db, x);
      }
    }
  });

  it("reports how many stored secrets can still be decrypted with the configured key, naming only the ones that cannot", async () => {
    const good = await connector("DISABLED", "audit_provider_a", "readable-1234567890");
    const bad = await connector("DISABLED", "audit_provider_b", null);
    const r = await checkSecretsDecryptable(db);
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.ok).toBeGreaterThanOrEqual(1);
    const failed = r.failed.filter((f) => [good.id, bad.id].includes(f.connectorId));
    expect(failed.map((f) => f.connectorId)).toEqual([bad.id]);
    expect(Object.keys(failed[0]!).sort()).toEqual(["connectorId", "provider", "tenantId"]);
    expect(JSON.stringify(r)).not.toContain("readable-1234567890");
  });
});

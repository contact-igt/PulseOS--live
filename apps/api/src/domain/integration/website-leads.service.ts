import { and, eq } from "drizzle-orm";
import type { WebsiteFormView } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { connectors, connectorSecrets } from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../security/encryption.js";
import { applyWebsiteForm, connectorStatusFor, generateIntakeToken, readWebsiteForm, type WebsiteFormInput } from "./website-leads-rules.js";

type ConnectorRowT = typeof connectors.$inferSelect;
type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

const PROVIDER = "website_form";

/** The one website-intake connector of this hospital (tenant comes from the session, never the request). */
export async function findWebsiteConnector(db: Db, tenantId: string): Promise<ConnectorRowT | null> {
  const [row] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, PROVIDER))).limit(1);
  return row ?? null;
}

async function ensureWebsiteConnector(db: Db, tenantId: string, displayName: string): Promise<ConnectorRowT> {
  const existing = await findWebsiteConnector(db, tenantId);
  if (existing) return existing;
  // Real traffic from the first request: LIVE, not the fixture default of other Hub connectors. It starts DISABLED (no token yet, so
  // it must refuse everything, in older releases too: see connectorStatusFor) and only becomes CONNECTED after a real, authenticated
  // submission. The admin's intent (formEnabled) is on by default.
  await db
    .insert(connectors)
    .values({ tenantId, type: "ACQUISITION", provider: PROVIDER, displayName, capabilities: ["RECEIVE_FORM"], status: "DISABLED", mode: "LIVE", configuration: { formEnabled: true, requireToken: true } })
    .onConflictDoNothing();
  const created = await findWebsiteConnector(db, tenantId);
  if (!created) throw new Error("website connector could not be created");
  return created;
}

async function readSecrets(db: Db, connectorId: string): Promise<Record<string, unknown>> {
  const [stored] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, connectorId)).limit(1);
  if (!stored) return {};
  try {
    return decryptSecret(stored.encryptedPayload);
  } catch {
    return {};
  }
}

const hasToken = (secrets: Record<string, unknown>) => typeof secrets.intakeToken === "string" && secrets.intakeToken.length > 0;

/** What the Hub may show: settings and facts, and only whether a token exists, never its value. */
export function websiteFormView(row: ConnectorRowT | null, secretKeys: string[], publicBase: string | null): WebsiteFormView {
  const config = (row?.configuration as Record<string, unknown> | null) ?? null;
  const form = readWebsiteForm(config, row?.status ?? "NOT_CONFIGURED");
  return {
    connectorExists: !!row,
    intakePath: row ? `/forms/website/${row.id}` : null,
    publicBaseConfigured: publicBase !== null,
    ...form,
    hasToken: secretKeys.includes("intakeToken"),
    requireToken: config?.requireToken === true,
    lastSubmissionAt: row?.lastEventAt?.toISOString() ?? null,
    // A coarse category only: the connector's own error text can quote request data, which is never shown here.
    lastErrorSummary: row?.lastError ? "The last submission could not be processed. See Activity for when it happened." : null,
  };
}

/**
 * Save the structured settings of the website form (typed values, validated by the caller's schema). Settings only: never creates
 * a token, never touches other connectors. Switching the form off refuses every submission (the intake route answers 403) without
 * deleting a single patient, journey, event or token; switching it on again starts verification over.
 */
export async function saveWebsiteForm(db: Db, tenantId: string, input: WebsiteFormInput): Promise<Result<object>> {
  const connector = await ensureWebsiteConnector(db, tenantId, input.displayName);
  const secrets = await readSecrets(db, connector.id);
  const configuration = applyWebsiteForm((connector.configuration as Record<string, unknown> | null) ?? {}, input);

  // Held DISABLED while there is no token, whatever was chosen: see connectorStatusFor.
  const status = connectorStatusFor({ enabled: input.enabled, hasToken: hasToken(secrets), current: connector.status });

  await db.update(connectors).set({ configuration, status, displayName: input.displayName, updatedAt: new Date() }).where(eq(connectors.id, connector.id));
  return { ok: true };
}

/**
 * Create or replace the intake token. The previous token stops working the moment this commits (there is no overlap window: the
 * website's server must be given the new one straight away). The value is returned exactly once, here; afterwards only "a token
 * exists" is ever readable. A token that was proven under the old value proves nothing about the new one, so verification restarts.
 */
export async function rotateWebsiteIntakeToken(db: Db, tenantId: string): Promise<Result<{ token: string }>> {
  const connector = await ensureWebsiteConnector(db, tenantId, "Website Contact Form");
  const secrets = { ...(await readSecrets(db, connector.id)) };
  const token = generateIntakeToken();
  secrets.intakeToken = token;
  const encryptedPayload = encryptSecret(secrets);
  await db.insert(connectorSecrets).values({ connectorId: connector.id, encryptedPayload }).onConflictDoUpdate({ target: connectorSecrets.connectorId, set: { encryptedPayload, updatedAt: new Date() } });

  // The admin's own choice decides whether it opens now; either way a token proved under the old value proves nothing.
  const intent = readWebsiteForm((connector.configuration as Record<string, unknown> | null) ?? {}, connector.status).enabled;
  const status = connectorStatusFor({ enabled: intent, hasToken: true, current: "CONNECTING" });
  await db.update(connectors).set({ status, updatedAt: new Date() }).where(eq(connectors.id, connector.id));
  return { ok: true, token };
}

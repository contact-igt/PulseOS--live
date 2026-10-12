import { checkProviderTemplate, templateVariablesUsed, type ProviderTemplateCatalogue, type ProviderTemplateProblem } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { getConnectorByTenantAndProvider, getConnectorSecrets } from "../connector/connector.service.js";
import { whatsNexusAdapter, type WhatsNexusTemplatesResult } from "../connector/adapters/whatsnexus.js";

const WHATSNEXUS_PROVIDER = "whatsnexus";

export interface CatalogueDeps {
  /** Replaceable in tests. */
  listTemplates?: (config: Record<string, unknown>, secrets: Record<string, unknown>) => Promise<WhatsNexusTemplatesResult>;
}

type Connector = NonNullable<Awaited<ReturnType<typeof getConnectorByTenantAndProvider>>>;
interface Setup {
  connector: Connector | null;
  config: Record<string, unknown>;
  /** WhatsNexus is the connector chosen for sending (the same flag `resolveSendProvider` reads). */
  active: boolean;
}

async function loadSetup(db: Db, tenantId: string): Promise<Setup> {
  const connector = await getConnectorByTenantAndProvider(db, tenantId, WHATSNEXUS_PROVIDER);
  const config = (connector?.configuration as Record<string, unknown> | null) ?? {};
  return { connector, config, active: !!connector && String(config.useForSending ?? "") === "true" };
}

async function readCatalogue(db: Db, tenantId: string, setup: Setup, deps: CatalogueDeps, now: Date): Promise<ProviderTemplateCatalogue> {
  const { connector, config, active } = setup;
  const empty = (state: ProviderTemplateCatalogue["state"], message: string): ProviderTemplateCatalogue => ({ provider: "whatsnexus", active, state, message, templates: [], fetchedAt: now.toISOString() });
  if (!connector) return empty("NOT_CONFIGURED", "WhatsNexus has not been configured yet. Save the base URL, tenant id and credentials first.");
  if (connector.status === "DISABLED") return empty("DISABLED", "This integration is switched off.");
  if (connector.mode !== "LIVE") return empty("NOT_LIVE", "Set the connection mode to Live (Credentials tab) to read WhatsNexus templates. Fixture and Sandbox never contact WhatsNexus.");

  let secrets: Record<string, unknown> = {};
  try {
    secrets = (await getConnectorSecrets(db, connector.id)) ?? {};
  } catch {
    secrets = {};
  }
  const list = deps.listTemplates ?? whatsNexusAdapter.listTemplates;
  const res = await list({ ...config, mode: "live", pulseosTenantId: tenantId }, secrets);
  if (!res.ok) return empty(res.state, res.message);
  return { provider: "whatsnexus", active, state: "OK", message: null, templates: res.templates, fetchedAt: now.toISOString() };
}

/**
 * The hospital's approved WhatsNexus templates, read from WhatsNexus right now. WhatsNexus is the source of truth (Meta
 * approval, language, placeholders, WABA), so nothing is stored or cached here: Meta approval can change at any time.
 * Never throws and never sends a message; "why there is no list" is reported in `state`.
 */
export async function fetchProviderTemplateCatalogue(db: Db, tenantId: string, deps: CatalogueDeps = {}, now: Date = new Date()): Promise<ProviderTemplateCatalogue> {
  return readCatalogue(db, tenantId, await loadSetup(db, tenantId), deps, now);
}

export type ProviderValidation =
  | { ok: true }
  | { ok: false; reason: "template_incompatible"; detail: { code: ProviderTemplateProblem; message: string } }
  | { ok: false; reason: "catalogue_unavailable"; detail: { code: "CATALOGUE_UNAVAILABLE"; message: string } };

/**
 * Is this reminder allowed to point at this provider template? Only enforced while WhatsNexus is the sending provider; a
 * hospital that sends through Meta keeps its free-text template name (and WhatsNexus is not contacted at all). If WhatsNexus
 * is the sender but its list cannot be read, the answer is "no, and here is why" — an unverified name is exactly the mistake
 * this check exists to stop.
 */
export async function validateAgainstProvider(db: Db, tenantId: string, want: { providerTemplateName: string; language: string; body: string }, deps: CatalogueDeps = {}): Promise<ProviderValidation> {
  const setup = await loadSetup(db, tenantId);
  if (!setup.active) return { ok: true };
  const catalogue = await readCatalogue(db, tenantId, setup, deps, new Date());
  if (catalogue.state !== "OK") {
    return { ok: false, reason: "catalogue_unavailable", detail: { code: "CATALOGUE_UNAVAILABLE", message: `Could not check this against WhatsNexus: ${catalogue.message ?? "its template list is unavailable"}` } };
  }
  const check = checkProviderTemplate({ providerTemplateName: want.providerTemplateName, language: want.language, variableCount: templateVariablesUsed(want.body).length }, catalogue.templates);
  return check.ok ? { ok: true } : { ok: false, reason: "template_incompatible", detail: { code: check.code, message: check.message } };
}

import type { Db } from "../../db/client.js";
import type { AcquisitionProviderAdapter, LeadReference } from "./types.js";
import { ingestNormalizedLead, type IngestLeadOptions } from "./lead-ingestion.service.js";

// Shared by every provider that delivers a two-step lead webhook (Meta Lead
// Ads, Google Ads Lead Forms) — a notification carrying only ids, then a
// separate authenticated fetch for the actual submitted data. The
// per-provider route supplies its own adapter instance and ingestOptions
// (task copy, event-type names); this function just wires
// fetchLead -> ingestNormalizedLead.
export async function processProviderLead(
  db: Db,
  tenantId: string,
  adapter: AcquisitionProviderAdapter,
  ref: LeadReference,
  config: Record<string, unknown>,
  secrets: Record<string, unknown>,
  ingestOptions: Omit<IngestLeadOptions, "description">,
): Promise<{ patientId: string; journeyId: string; touchpointId: string; journeyReused: boolean }> {
  if (!adapter.fetchLead) throw new Error("This acquisition adapter does not support fetchLead");
  const lead = await adapter.fetchLead(ref, config, secrets);
  return ingestNormalizedLead(db, tenantId, lead, { ...ingestOptions, description: null });
}

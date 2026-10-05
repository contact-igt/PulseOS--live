import { and, asc, eq } from "drizzle-orm";
import type { TreatmentDefinitionVm } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { treatmentDefinitions } from "../../db/schema.js";

// The tenant's treatment catalog: procedures a hospital offers, attached to a
// specialty by plain-text key (same pattern as custom_field_definitions). Like
// specialty templates it is data — see ophthalmology.templates.ts /
// gynecology.templates.ts — so nothing else in the product knows which
// procedures exist.

export interface TreatmentDefinitionSeed {
  specialtyKey: string;
  key: string;
  label: string;
  /** Demo / price-list hint (INR), used when a consultation outcome states no value. */
  defaultEstimatedValue: number | null;
  sortOrder: number;
}

function toVm(r: typeof treatmentDefinitions.$inferSelect): TreatmentDefinitionVm {
  return {
    id: r.id,
    specialtyKey: r.specialtyKey,
    key: r.key,
    label: r.label,
    defaultEstimatedValue: r.defaultEstimatedValue,
    sortOrder: r.sortOrder,
  };
}

/** Active catalog entries for a tenant, in catalog order, optionally limited to one specialty. */
export async function listActiveTreatmentDefinitions(db: Db, tenantId: string, specialtyKey?: string): Promise<TreatmentDefinitionVm[]> {
  const rows = await db
    .select()
    .from(treatmentDefinitions)
    .where(and(eq(treatmentDefinitions.tenantId, tenantId), eq(treatmentDefinitions.isActive, true), specialtyKey ? eq(treatmentDefinitions.specialtyKey, specialtyKey) : undefined))
    .orderBy(asc(treatmentDefinitions.sortOrder), asc(treatmentDefinitions.label));
  return rows.map(toVm);
}

/** The definition if — and only if — it is an active entry of this tenant. */
export async function findActiveTreatmentDefinition(db: Db, tenantId: string, id: string) {
  const [row] = await db
    .select()
    .from(treatmentDefinitions)
    .where(and(eq(treatmentDefinitions.tenantId, tenantId), eq(treatmentDefinitions.id, id), eq(treatmentDefinitions.isActive, true)))
    .limit(1);
  return row ?? null;
}

/** Idempotently installs catalog entries for a tenant (existing keys are left untouched). */
export async function ensureTreatmentCatalog(db: Db, tenantId: string, definitions: TreatmentDefinitionSeed[]): Promise<void> {
  if (definitions.length === 0) return;
  await db
    .insert(treatmentDefinitions)
    .values(definitions.map((d) => ({ tenantId, specialtyKey: d.specialtyKey, key: d.key, label: d.label, defaultEstimatedValue: d.defaultEstimatedValue, sortOrder: d.sortOrder })))
    .onConflictDoNothing({ target: [treatmentDefinitions.tenantId, treatmentDefinitions.key] });
}

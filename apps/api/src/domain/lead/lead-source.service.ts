import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { leadSources } from "../../db/schema.js";
import type { CreateLeadSourceInput, LeadSourceVm, SourceChannel, UpdateLeadSourceInput } from "@pulseos/types";

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

// The Beta V1 default catalogue every tenant starts from, then owns. `bucket` maps a source onto the coarse
// platform enum that campaigns, attribution and analytics have always used. The last three are the legacy values
// the old single enum carried: archived (not offered for new leads) but kept so existing journeys, and the
// integrations that still report "meta" / "website" / "organic", resolve to a real entry.
export const DEFAULT_LEAD_SOURCES: { key: string; label: string; bucket: SourceChannel; archived: boolean }[] = [
  { key: "instagram", label: "Instagram", bucket: "meta", archived: false },
  { key: "facebook", label: "Facebook", bucket: "meta", archived: false },
  { key: "youtube", label: "YouTube", bucket: "other", archived: false },
  { key: "google", label: "Google", bucket: "google", archived: false },
  { key: "referral", label: "Referral", bucket: "referral", archived: false },
  { key: "direct", label: "Direct", bucket: "organic", archived: false },
  { key: "walk_in", label: "Walk-in", bucket: "walk_in", archived: false },
  { key: "phone", label: "Phone", bucket: "phone", archived: false },
  { key: "whatsapp", label: "WhatsApp", bucket: "whatsapp", archived: false },
  { key: "other", label: "Other", bucket: "other", archived: false },
  { key: "meta", label: "Meta ads (Facebook / Instagram)", bucket: "meta", archived: true },
  { key: "website", label: "Website", bucket: "website", archived: true },
  { key: "organic", label: "Organic", bucket: "organic", archived: true },
];

const toVm = (r: typeof leadSources.$inferSelect): LeadSourceVm => ({ id: r.id, key: r.key, label: r.label, bucket: r.bucket, archived: r.archived, sortOrder: r.sortOrder });

/** Idempotently gives a tenant the default catalogue the first time it is needed (a hospital's later edits are never overwritten). */
export async function ensureLeadSources(db: Db, tenantId: string): Promise<void> {
  // The common case (already installed) is one cheap read, not a write on every request.
  const [existing] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.tenantId, tenantId)).limit(1);
  if (existing) return;
  await db
    .insert(leadSources)
    .values(DEFAULT_LEAD_SOURCES.map((s, i) => ({ tenantId, key: s.key, label: s.label, bucket: s.bucket, archived: s.archived, sortOrder: i })))
    .onConflictDoNothing({ target: [leadSources.tenantId, leadSources.key] });
}

export async function listLeadSources(db: Db, tenantId: string, includeArchived = false): Promise<LeadSourceVm[]> {
  await ensureLeadSources(db, tenantId);
  const rows = await db
    .select()
    .from(leadSources)
    .where(and(eq(leadSources.tenantId, tenantId), includeArchived ? undefined : eq(leadSources.archived, false)))
    .orderBy(asc(leadSources.sortOrder), asc(leadSources.label));
  return rows.map(toVm);
}

export type ResolvedLeadSource = { id: string; key: string; label: string; bucket: SourceChannel };

/**
 * Finds the tenant's source for a key. `allowArchived` is for integrations and legacy callers that still report
 * a coarse value ("meta", "website"): they resolve even when the hospital has archived that entry. A person
 * choosing a source for a new lead never may.
 */
export async function resolveLeadSource(db: Db, tenantId: string, key: string, opts: { allowArchived: boolean }): Promise<ResolvedLeadSource | null> {
  await ensureLeadSources(db, tenantId);
  const [row] = await db.select().from(leadSources).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.key, key))).limit(1);
  if (!row || (row.archived && !opts.allowArchived)) return null;
  return { id: row.id, key: row.key, label: row.label, bucket: row.bucket };
}

const slug = (label: string) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

export async function createLeadSource(db: Db, tenantId: string, input: CreateLeadSourceInput): Promise<Result<{ source: LeadSourceVm }>> {
  const label = input.label?.trim();
  if (!label || label.length > 60) return { ok: false, reason: "invalid_request" };
  const base = slug(label);
  if (!base) return { ok: false, reason: "invalid_request" };
  await ensureLeadSources(db, tenantId);
  const rows = await db.select().from(leadSources).where(eq(leadSources.tenantId, tenantId));
  if (rows.some((r) => r.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: "source_exists" };
  const key = rows.some((r) => r.key === `custom_${base}`) ? `custom_${base}_${rows.length}` : `custom_${base}`;
  const [row] = await db
    .insert(leadSources)
    .values({ tenantId, key, label, bucket: input.bucket ?? "other", sortOrder: rows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1 })
    .returning();
  return { ok: true, source: toVm(row) };
}

export async function updateLeadSource(db: Db, tenantId: string, id: string, input: UpdateLeadSourceInput): Promise<Result<{ source: LeadSourceVm }>> {
  const [existing] = await db.select().from(leadSources).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "source_not_found" };
  const label = input.label?.trim();
  if (input.label !== undefined && (!label || label.length > 60)) return { ok: false, reason: "invalid_request" };
  if (label && label.toLowerCase() !== existing.label.toLowerCase()) {
    const others = await db.select({ label: leadSources.label }).from(leadSources).where(eq(leadSources.tenantId, tenantId));
    if (others.some((o) => o.label.toLowerCase() === label.toLowerCase())) return { ok: false, reason: "source_exists" };
  }
  const [row] = await db
    .update(leadSources)
    .set({
      ...(label !== undefined ? { label } : {}),
      ...(input.bucket !== undefined ? { bucket: input.bucket } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
    })
    .where(eq(leadSources.id, id))
    .returning();
  return { ok: true, source: toVm(row) };
}

/**
 * Saves a new order for (some of) this hospital's sources. The ids listed take, in the order given, the sort slots they
 * already held together — so reordering a few never disturbs the others. Every id must belong to THIS hospital.
 */
export async function reorderLeadSources(db: Db, tenantId: string, orderedIds: string[]): Promise<Result> {
  if (orderedIds.length === 0 || new Set(orderedIds).size !== orderedIds.length) return { ok: false, reason: "invalid_request" };
  // Read the slots INSIDE the transaction with a row lock, so two admins reordering at once serialise instead of interleaving.
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(leadSources).where(and(eq(leadSources.tenantId, tenantId), inArray(leadSources.id, orderedIds))).for("update");
    if (rows.length !== orderedIds.length) return { ok: false as const, reason: "invalid_request" };
    let slots = rows.map((r) => r.sortOrder).sort((a, b) => a - b);
    if (new Set(slots).size !== slots.length) slots = slots.map((_, i) => slots[0]! + i);
    for (const [i, id] of orderedIds.entries()) await tx.update(leadSources).set({ sortOrder: slots[i]! }).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, id)));
    return { ok: true as const };
  });
}

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { branches, journeys, patients } from "../../db/schema.js";
import { normalizePhone, resolveDefaultPhoneRegion } from "./phone.js";

/** True when `branchId` is a branch of this hospital. Every client-supplied branch is checked with this before it is stored. */
export async function branchBelongsToTenant(db: Db, tenantId: string, branchId: string): Promise<boolean> {
  const [b] = await db.select({ id: branches.id }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, branchId))).limit(1);
  return !!b;
}

export interface ResolveOrCreatePatientInput {
  tenantId: string;
  phone: string;
  /** Optional: a caller or enquirer may not have given a name yet. Never pass a placeholder — pass nothing. */
  name?: string | null;
  /** Exact date of birth (YYYY-MM-DD). */
  dateOfBirth?: string | null;
  /** The age the patient reported, when no date of birth is known. */
  reportedAge?: number | null;
  email?: string | null;
  preferredLanguage?: string;
  branchId?: string | null;
}

export interface ResolveOrCreatePatientResult {
  patient: typeof patients.$inferSelect;
  isNewPatient: boolean;
}

type PatientRow = typeof patients.$inferSelect;

const cleanName = (name: string | null | undefined): string | null => {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
};

/**
 * A later contact may learn what an earlier one did not (the caller's name, their age). Missing details are filled
 * in; a detail the hospital already holds is never overwritten by whoever happens to contact next.
 */
async function fillMissingDetails(db: Db, existing: PatientRow, input: ResolveOrCreatePatientInput): Promise<PatientRow> {
  const name = cleanName(input.name);
  const patch: Partial<typeof patients.$inferInsert> = {};
  if (!cleanName(existing.name) && name) patch.name = name;
  if (!existing.dateOfBirth && input.dateOfBirth) patch.dateOfBirth = input.dateOfBirth;
  if (existing.reportedAge === null && input.reportedAge != null) patch.reportedAge = input.reportedAge;
  if (Object.keys(patch).length === 0) return existing;
  const [updated] = await db.update(patients).set(patch).where(eq(patients.id, existing.id)).returning();
  return updated ?? existing;
}

/**
 * The ONE identity resolution path every entry point converges onto — manual Add Patient, manual Add Lead,
 * WhatsApp/Runo webhook identity resolution, and Website/Meta/Google Ads lead ingestion. Normalizes the raw phone
 * to canonical E.164 using the tenant's default region and matches on that — so "+91 98765 43210",
 * "919876543210" and "09876543210" all resolve to the same Patient regardless of which source captured them.
 * When normalization fails there is no canonical key, so the fallback is an exact match on the raw string —
 * never fuzzy, never an automatic merge of two uncertain identities.
 *
 * The database enforces one Patient per tenant per number (partial unique indexes), and the insert below is
 * `ON CONFLICT DO NOTHING`: two requests racing on a brand-new number both end up with the same row — one creates
 * it, the other re-reads it — instead of producing a duplicate.
 *
 * Callers own their own post-creation side effects (Timeline events differ by source, Journey creation only
 * happens for acquisition-first flows) — this function only ever touches the Patient row itself.
 */
export async function resolveOrCreatePatient(db: Db, input: ResolveOrCreatePatientInput): Promise<ResolveOrCreatePatientResult> {
  const defaultRegion = await resolveDefaultPhoneRegion(db, input.tenantId);
  const normalized = normalizePhone(input.phone, defaultRegion);

  const findExisting = async (): Promise<PatientRow | undefined> => {
    const [row] = normalized.e164
      ? await db.select().from(patients).where(and(eq(patients.tenantId, input.tenantId), eq(patients.phoneE164, normalized.e164))).limit(1)
      : await db.select().from(patients).where(and(eq(patients.tenantId, input.tenantId), eq(patients.phone, input.phone), isNull(patients.phoneE164))).limit(1);
    return row;
  };

  const existing = await findExisting();
  if (existing) return { patient: await fillMissingDetails(db, existing, input), isNewPatient: false };

  // A branch that is not this hospital's (a stale or hostile id from a public form or a client) is dropped, never stored.
  const branchId = input.branchId && (await branchBelongsToTenant(db, input.tenantId, input.branchId)) ? input.branchId : null;

  const values = {
    tenantId: input.tenantId,
    name: cleanName(input.name),
    dateOfBirth: input.dateOfBirth ?? null,
    reportedAge: input.reportedAge ?? null,
    phone: input.phone,
    phoneE164: normalized.e164,
    phoneCountry: normalized.country,
    email: input.email ?? null,
    preferredLanguage: input.preferredLanguage ?? "English",
    branchId,
  };
  const inserted = await db
    .insert(patients)
    .values(values)
    .onConflictDoNothing(
      normalized.e164
        ? { target: [patients.tenantId, patients.phoneE164], where: sql`${patients.phoneE164} is not null` }
        : { target: [patients.tenantId, patients.phone], where: sql`${patients.phoneE164} is null` },
    )
    .returning();
  if (inserted[0]) return { patient: inserted[0], isNewPatient: true };

  // Lost the race: someone else created this Patient between our read and our insert.
  const winner = await findExisting();
  if (!winner) throw new Error("patient insert conflicted but the existing patient could not be found");
  return { patient: await fillMissingDetails(db, winner, input), isNewPatient: false };
}

/**
 * Thin compatibility wrapper for the inbound-connector call sites (WhatsApp/Runo webhooks), which only ever have
 * a phone and, sometimes, a display name. An unknown name stays unknown (NULL) — no invented "Unknown caller".
 */
export async function findOrCreatePatientByPhone(db: Db, tenantId: string, phone: string, name: string | null, branchId?: string | null) {
  const { patient } = await resolveOrCreatePatient(db, { tenantId, phone, name, branchId: branchId ?? null });
  return patient;
}

// "Resolve Journey where possible" — the patient's most recently created
// journey that hasn't already reached a terminal stage. No journey is
// created here; a call/message never fabricates a journey on its own.
export async function findMostRecentActiveJourney(db: Db, tenantId: string, patientId: string) {
  const [journey] = await db
    .select()
    .from(journeys)
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.patientId, patientId), ne(journeys.stage, "completed"), ne(journeys.stage, "lost")))
    .orderBy(desc(journeys.createdAt))
    .limit(1);
  return journey ?? null;
}

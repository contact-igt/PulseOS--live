import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { branches, campaignTouchpoints, customFieldValues, journeys, leadSources, marketingCampaigns, patients, specialtyTemplates, timelineEvents, users } from "../../db/schema.js";
import { patientNameSql } from "../../lib/patient-name.js";
import { dayKeyIn } from "../../lib/hospital-time.js";
import { normalizePhone, resolveDefaultPhoneRegion } from "../patient/phone.js";
import { eligibleAssignee } from "../task/task.service.js";
import { branchBelongsToTenant } from "../patient/identity.service.js";
import { formatFieldValue, listFieldsForEntry, loadJourneyValuesByKey, resolveSubmittedValues } from "../crm/crm-field.service.js";
import { resolveLeadSource } from "./lead-source.service.js";
import { cleanText, planJourneyUpdate, planPatientUpdate, summarizeChanges } from "./lead-edit.logic.js";
import { leadEditPermissions, type LeadChange, type LeadEditModel, type Role, type UpdateLeadInput, type UpdateLeadResult } from "@pulseos/types";

export type UpdateLeadOutcome =
  | { ok: true; result: UpdateLeadResult }
  | { ok: false; reason: "not_found" | "stale_version" }
  | { ok: false; reason: "forbidden"; groups: string[] }
  | { ok: false; reason: "phone_in_use"; patient: { id: string; name: string } | null }
  | { ok: false; reason: "invalid"; missingRequiredFields: string[]; invalidFields: string[]; readOnlyFields: string[] };

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const versionOf = (d: Date) => d.toISOString();
const SAME_INSTANT = (a: Date, iso: string) => a.getTime() === new Date(iso).getTime();

/** What the Edit Lead form opens with: the current values of this lead's patient and journey, and what this person may change. */
export async function getLeadEditModel(db: Db, tenantId: string, journeyId: string, role: Role): Promise<LeadEditModel | null> {
  const [row] = await db
    .select({ j: journeys, p: patients, sourceKey: leadSources.key, sourceLabel: leadSources.label })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .leftJoin(leadSources, eq(journeys.sourceId, leadSources.id))
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId), eq(patients.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;

  const [first] = await db
    .select({ id: marketingCampaigns.id, name: marketingCampaigns.name })
    .from(campaignTouchpoints)
    .innerJoin(marketingCampaigns, eq(campaignTouchpoints.campaignId, marketingCampaigns.id))
    .where(and(eq(campaignTouchpoints.tenantId, tenantId), eq(campaignTouchpoints.journeyId, journeyId), eq(campaignTouchpoints.touchType, "first_touch")))
    .limit(1);

  const fields = row.j.specialtyKey ? await listFieldsForEntry(db, tenantId, role, { placement: "journey_detail", specialtyKey: row.j.specialtyKey }) : [];
  const stored = await loadJourneyValuesByKey(db, tenantId, journeyId);
  const keys = new Set(fields.map((f) => f.key));

  return {
    journeyId,
    patientId: row.p.id,
    versions: { patient: versionOf(row.p.updatedAt), journey: versionOf(row.j.updatedAt) },
    patient: {
      name: row.p.name,
      dateOfBirth: row.p.dateOfBirth,
      age: row.p.reportedAge,
      phone: row.p.phone,
      email: row.p.email,
      preferredLanguage: row.p.preferredLanguage,
      branchId: row.p.branchId,
      marketingConsent: row.p.marketingConsent,
    },
    journey: {
      journeyType: row.j.journeyType,
      specialtyKey: row.j.specialtyKey,
      sourceKey: row.sourceKey,
      sourceLabel: row.sourceLabel ?? row.j.source,
      priority: row.j.priority,
      notes: row.j.notes,
      ownerId: row.j.ownerUserId,
      stage: row.j.stage,
      campaign: first ?? null,
    },
    fields,
    fieldValues: Object.fromEntries(Object.entries(stored).filter(([k]) => keys.has(k))),
    can: leadEditPermissions(role),
  };
}

/** Postgres unique-violation, wherever the driver wrapped it. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/**
 * Edit Lead in ONE transaction: the patient's details, the journey's details and its custom fields, or nothing.
 * Everything a client points at (branch, owner, source, service) must belong to THIS hospital; each field group is checked
 * against the caller's role; a copy older than the stored rows is refused. Every change is recorded on the Timeline with
 * its before and after (note text excepted).
 */
export async function updateLead(db: Db, tenantId: string, actor: { id: string; role: Role }, journeyId: string, input: UpdateLeadInput, timezone: string, now: Date = new Date()): Promise<UpdateLeadOutcome> {
  try {
    return await db.transaction((tx) => updateLeadIn(tx as unknown as Db, tenantId, actor, journeyId, input, timezone, now));
  } catch (err) {
    // Two edits racing for the same number: the database's one-patient-per-number rule decides.
    if (isUniqueViolation(err)) return { ok: false, reason: "phone_in_use", patient: null };
    throw err;
  }
}

async function updateLeadIn(db: Db, tenantId: string, actor: { id: string; role: Role }, journeyId: string, input: UpdateLeadInput, timezone: string, now: Date): Promise<UpdateLeadOutcome> {
  const can = leadEditPermissions(actor.role);
  const patientPatch = input.patient ?? {};
  const journeyPatch = input.journey ?? {};
  const submittedFields = input.customFieldValues ?? {};
  const touchesPatient = Object.values(patientPatch).some((v) => v !== undefined);
  const touchesJourney = Object.values(journeyPatch).some((v) => v !== undefined) || Object.keys(submittedFields).length > 0;

  // Row-locked, so two saves cannot both pass the version check.
  const [journey] = await db.select().from(journeys).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).for("update").limit(1);
  if (!journey) return { ok: false, reason: "not_found" };
  const [patient] = await db.select().from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, journey.patientId))).for("update").limit(1);
  if (!patient) return { ok: false, reason: "not_found" };

  const forbidden: string[] = [];
  if (touchesPatient && !can.editPatient) forbidden.push("patient");
  const { ownerId, sourceKey, sourceReason, specialtyKey, ...plainJourney } = journeyPatch;
  if ((plainJourney.journeyType !== undefined || plainJourney.priority !== undefined || plainJourney.notes !== undefined || specialtyKey !== undefined || Object.keys(submittedFields).length > 0) && !can.editJourney) forbidden.push("journey");

  const [currentSource] = journey.sourceId ? await db.select({ key: leadSources.key, label: leadSources.label }).from(leadSources).where(eq(leadSources.id, journey.sourceId)).limit(1) : [];
  if (ownerId !== undefined && ownerId !== journey.ownerUserId && !can.changeOwner) forbidden.push("owner");
  if (sourceKey !== undefined && sourceKey !== currentSource?.key && !can.changeSource) forbidden.push("source");
  if (forbidden.length > 0) return { ok: false, reason: "forbidden", groups: forbidden };

  if ((touchesPatient && !SAME_INSTANT(patient.updatedAt, input.versions.patient)) || (touchesJourney && !SAME_INSTANT(journey.updatedAt, input.versions.journey))) return { ok: false, reason: "stale_version" };

  const invalid: string[] = [];
  const changes: LeadChange[] = [];
  const todayKey = dayKeyIn(now, timezone);

  // Patient: values that need no lookup, then the ones that do.
  const { phone: rawPhone, branchId, ...plainPatient } = patientPatch;
  const patientPlan = planPatientUpdate({ name: patient.name, dateOfBirth: patient.dateOfBirth, reportedAge: patient.reportedAge, email: patient.email, preferredLanguage: patient.preferredLanguage, marketingConsent: patient.marketingConsent }, plainPatient, todayKey);
  if (patientPlan.ok) changes.push(...patientPlan.changes);
  else invalid.push(...patientPlan.invalid);
  const patientSet: Partial<typeof patients.$inferInsert> = patientPlan.ok ? { ...patientPlan.set } : {};

  if (rawPhone !== undefined) {
    const raw = rawPhone.trim();
    if (raw.length < 6) invalid.push("phone");
    else {
      const normalized = normalizePhone(raw, await resolveDefaultPhoneRegion(db, tenantId));
      const sameIdentity = normalized.e164 ? normalized.e164 === patient.phoneE164 : patient.phoneE164 === null && raw === patient.phone;
      if (!sameIdentity) {
        const [taken] = await db
          .select({ id: patients.id, name: patientNameSql })
          .from(patients)
          .where(and(eq(patients.tenantId, tenantId), ne(patients.id, patient.id), normalized.e164 ? eq(patients.phoneE164, normalized.e164) : and(eq(patients.phone, raw), sql`${patients.phoneE164} is null`)))
          .limit(1);
        if (taken) return { ok: false, reason: "phone_in_use", patient: taken };
      }
      if (raw !== patient.phone || !sameIdentity) {
        patientSet.phone = raw;
        patientSet.phoneE164 = normalized.e164;
        patientSet.phoneCountry = normalized.country;
        changes.push({ field: "phone", label: "Phone", from: patient.phone, to: raw });
      }
    }
  }

  if (branchId !== undefined && branchId !== patient.branchId) {
    if (branchId !== null && !(await branchBelongsToTenant(db, tenantId, branchId))) invalid.push("branchId");
    else {
      const names = new Map((await db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, tenantId))).map((b) => [b.id, b.name]));
      patientSet.branchId = branchId;
      changes.push({ field: "branchId", label: "Branch", from: patient.branchId ? (names.get(patient.branchId) ?? null) : null, to: branchId ? (names.get(branchId) ?? null) : null });
    }
  }

  // Journey.
  const journeyPlan = planJourneyUpdate({ journeyType: journey.journeyType, priority: journey.priority, notes: journey.notes }, plainJourney);
  if (journeyPlan.ok) changes.push(...journeyPlan.changes);
  else invalid.push(...journeyPlan.invalid);
  const journeySet: Partial<typeof journeys.$inferInsert> = journeyPlan.ok ? { ...journeyPlan.set } : {};

  let effectiveSpecialty = journey.specialtyKey;
  if (specialtyKey !== undefined && specialtyKey !== journey.specialtyKey) {
    const [template] = await db.select({ key: specialtyTemplates.key, displayName: specialtyTemplates.displayName, departmentId: specialtyTemplates.departmentId }).from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, specialtyKey))).limit(1);
    if (!template) invalid.push("specialtyKey");
    else {
      const [from] = journey.specialtyKey ? await db.select({ displayName: specialtyTemplates.displayName }).from(specialtyTemplates).where(and(eq(specialtyTemplates.tenantId, tenantId), eq(specialtyTemplates.key, journey.specialtyKey))).limit(1) : [];
      journeySet.specialtyKey = template.key;
      journeySet.departmentId = template.departmentId;
      effectiveSpecialty = template.key;
      changes.push({ field: "specialtyKey", label: "Service", from: from?.displayName ?? journey.specialtyKey, to: template.displayName });
    }
  }

  if (ownerId !== undefined && ownerId !== journey.ownerUserId) {
    const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, tenantId))).map((u) => [u.id, u.name]));
    if (ownerId !== null && !(await eligibleAssignee(db, tenantId, ownerId))) invalid.push("ownerId");
    else {
      journeySet.ownerUserId = ownerId;
      changes.push({ field: "ownerId", label: "Team member", from: journey.ownerUserId ? (names.get(journey.ownerUserId) ?? null) : null, to: ownerId ? (names.get(ownerId) ?? null) : null });
    }
  }

  let sourceChange: { change: LeadChange; reason: string; key: string } | null = null;
  if (sourceKey !== undefined && sourceKey !== currentSource?.key) {
    const resolved = await resolveLeadSource(db, tenantId, sourceKey, { allowArchived: false });
    const reason = cleanText(sourceReason);
    if (!resolved) invalid.push("sourceKey");
    if (!reason) invalid.push("sourceReason");
    if (resolved && reason) {
      journeySet.source = resolved.bucket;
      journeySet.sourceId = resolved.id;
      sourceChange = { change: { field: "source", label: "Source", from: currentSource?.label ?? journey.source, to: resolved.label }, reason, key: resolved.key };
    }
  }

  // Custom fields: only fields this person may see, in this service, that were sent or already hold a value.
  // (A required field a lead never had cannot block an unrelated edit.)
  const missing: string[] = [];
  const readOnlyFields: string[] = [];
  const upserts: { fieldDefinitionId: string; value: unknown }[] = [];
  const deletes: string[] = [];
  if (Object.keys(submittedFields).length > 0 && effectiveSpecialty) {
    const fields = await listFieldsForEntry(db, tenantId, actor.role, { placement: "journey_detail", specialtyKey: effectiveSpecialty });
    const existing = await loadJourneyValuesByKey(db, tenantId, journeyId);
    const scoped = fields.filter((f) => f.key in submittedFields || !isEmpty(existing[f.key]));
    const resolved = resolveSubmittedValues(scoped, { ...existing, ...submittedFields }, { existing });
    if (!resolved.ok) {
      missing.push(...resolved.missing);
      invalid.push(...resolved.invalid);
      readOnlyFields.push(...(resolved.readOnly ?? []));
    } else {
      for (const { field, value } of resolved.values) {
        if (sameValue(existing[field.key], value)) continue;
        upserts.push({ fieldDefinitionId: field.id, value });
        changes.push({ field: `field:${field.key}`, label: field.label, from: isEmpty(existing[field.key]) ? null : formatFieldValue(field.fieldType, existing[field.key], timezone), to: formatFieldValue(field.fieldType, value, timezone) });
      }
      // Cleared: sent empty while a value is stored.
      for (const field of scoped) {
        if (!(field.key in submittedFields) || !isEmpty(submittedFields[field.key]) || isEmpty(existing[field.key])) continue;
        if (field.readOnly) {
          readOnlyFields.push(field.key);
          continue;
        }
        deletes.push(field.id);
        changes.push({ field: `field:${field.key}`, label: field.label, from: formatFieldValue(field.fieldType, existing[field.key], timezone), to: null });
      }
    }
  }

  if (invalid.length > 0 || missing.length > 0 || readOnlyFields.length > 0) {
    return { ok: false, reason: "invalid", missingRequiredFields: missing, invalidFields: invalid, readOnlyFields };
  }

  const allChanges = sourceChange ? [...changes, sourceChange.change] : changes;
  if (allChanges.length === 0) return { ok: true, result: { changes: [], versions: { patient: versionOf(patient.updatedAt), journey: versionOf(journey.updatedAt) } } };

  // Writes. Nothing above wrote anything, so every refusal left the lead untouched.
  const written = new Date();
  const patientUpdatedAt =
    Object.keys(patientSet).length > 0
      ? (await db.update(patients).set({ ...patientSet, updatedAt: written }).where(and(eq(patients.tenantId, tenantId), eq(patients.id, patient.id))).returning({ updatedAt: patients.updatedAt }))[0]!.updatedAt
      : patient.updatedAt;
  const [savedJourney] = await db.update(journeys).set({ ...journeySet, updatedAt: written }).where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId))).returning({ updatedAt: journeys.updatedAt });
  for (const { fieldDefinitionId, value } of upserts) {
    await db
      .insert(customFieldValues)
      .values({ tenantId, journeyId, fieldDefinitionId, value })
      .onConflictDoUpdate({ target: [customFieldValues.journeyId, customFieldValues.fieldDefinitionId], set: { value } });
  }
  for (const fieldDefinitionId of deletes) {
    await db.delete(customFieldValues).where(and(eq(customFieldValues.tenantId, tenantId), eq(customFieldValues.journeyId, journeyId), eq(customFieldValues.fieldDefinitionId, fieldDefinitionId)));
  }

  if (changes.length > 0) {
    await db.insert(timelineEvents).values({
      tenantId, patientId: patient.id, journeyId, actorType: "user", actorId: actor.id, eventType: "lead_updated",
      title: "Lead details updated", description: summarizeChanges(changes), metadata: { changes }, occurredAt: now,
    });
  }
  if (sourceChange) {
    await db.insert(timelineEvents).values({
      tenantId, patientId: patient.id, journeyId, actorType: "user", actorId: actor.id, eventType: "lead_source_corrected",
      title: `Source corrected: ${sourceChange.change.from} → ${sourceChange.change.to}`, description: `Reason: ${sourceChange.reason}`,
      sourceChannel: sourceChange.key, metadata: { changes: [sourceChange.change] }, occurredAt: now,
    });
  }

  return { ok: true, result: { changes: allChanges, versions: { patient: versionOf(patientUpdatedAt), journey: versionOf(savedJourney!.updatedAt) } } };
}

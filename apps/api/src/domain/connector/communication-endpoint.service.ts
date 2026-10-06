import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { branchBelongsToTenant } from "../patient/identity.service.js";
import { normalizePhone, resolveDefaultPhoneRegion } from "../patient/phone.js";
import { branches, communicationEndpoints, connectors, departments, leadSources } from "../../db/schema.js";
import type { CommunicationEndpointVm, CreateCommunicationEndpointInput, UpdateCommunicationEndpointInput } from "@pulseos/types";

type EndpointRow = typeof communicationEndpoints.$inferSelect;
type Joined = { endpoint: EndpointRow; connectorProvider: string; branchName: string | null; leadSourceLabel: string | null; departmentName: string | null };

function toVm(r: Joined): CommunicationEndpointVm {
  const row = r.endpoint;
  return {
    id: row.id,
    connectorId: row.connectorId,
    connectorProvider: r.connectorProvider,
    branchId: row.branchId,
    branchName: r.branchName,
    type: row.type,
    provider: row.provider,
    publicNumber: row.publicNumber,
    providerRef: row.providerRef,
    displayLabel: row.displayLabel,
    isActive: row.isActive,
    leadSourceId: row.leadSourceId,
    leadSourceLabel: r.leadSourceLabel,
    sourceDetail: row.sourceDetail,
    departmentId: row.departmentId,
    departmentName: r.departmentName,
  };
}

/** One query shape for every read: the endpoint plus the names of what it points at (branch, source, department). */
function selectJoined(db: Db) {
  return db
    .select({ endpoint: communicationEndpoints, connectorProvider: connectors.provider, branchName: branches.name, leadSourceLabel: leadSources.label, departmentName: departments.displayName })
    .from(communicationEndpoints)
    .innerJoin(connectors, eq(communicationEndpoints.connectorId, connectors.id))
    .leftJoin(branches, eq(communicationEndpoints.branchId, branches.id))
    .leftJoin(leadSources, eq(communicationEndpoints.leadSourceId, leadSources.id))
    .leftJoin(departments, eq(communicationEndpoints.departmentId, departments.id));
}

async function findConnector(db: Db, tenantId: string, connectorId: string) {
  const [row] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, connectorId))).limit(1);
  return row ?? null;
}

async function vmById(db: Db, tenantId: string, endpointId: string): Promise<CommunicationEndpointVm> {
  const [r] = await selectJoined(db).where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.id, endpointId))).limit(1);
  return toVm(r!);
}

type RefReason = "branch_not_found" | "source_not_found" | "department_not_found";

/** Every id an endpoint points at must belong to THIS tenant (and a source must still be offered): a foreign id is "not found". */
async function checkReferences(db: Db, tenantId: string, ids: { branchId?: string | null; leadSourceId?: string | null; departmentId?: string | null }): Promise<RefReason | null> {
  if (ids.branchId && !(await branchBelongsToTenant(db, tenantId, ids.branchId))) return "branch_not_found";
  if (ids.leadSourceId) {
    const [s] = await db.select({ id: leadSources.id }).from(leadSources).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, ids.leadSourceId), eq(leadSources.archived, false))).limit(1);
    if (!s) return "source_not_found";
  }
  if (ids.departmentId) {
    const [d] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.id, ids.departmentId))).limit(1);
    if (!d) return "department_not_found";
  }
  return null;
}

const cleanDetail = (v: string | null | undefined) => (v == null ? null : v.trim().slice(0, 120) || null);

export async function listCommunicationEndpoints(db: Db, tenantId: string, connectorId?: string): Promise<CommunicationEndpointVm[]> {
  const conditions = connectorId
    ? and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId))
    : eq(communicationEndpoints.tenantId, tenantId);
  const rows = await selectJoined(db).where(conditions).orderBy(communicationEndpoints.displayLabel);
  return rows.map(toVm);
}

export async function createCommunicationEndpoint(
  db: Db,
  tenantId: string,
  connectorId: string,
  input: CreateCommunicationEndpointInput,
): Promise<{ ok: true; endpoint: CommunicationEndpointVm } | { ok: false; reason: "connector_not_found" | "provider_ref_already_exists" | RefReason }> {
  const connector = await findConnector(db, tenantId, connectorId);
  if (!connector) return { ok: false, reason: "connector_not_found" };

  const [existing] = await db
    .select({ id: communicationEndpoints.id })
    .from(communicationEndpoints)
    .where(and(eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.providerRef, input.providerRef)))
    .limit(1);
  if (existing) return { ok: false, reason: "provider_ref_already_exists" };
  const bad = await checkReferences(db, tenantId, input);
  if (bad) return { ok: false, reason: bad };

  const [row] = await db
    .insert(communicationEndpoints)
    .values({
      tenantId,
      connectorId,
      branchId: input.branchId ?? null,
      type: input.type,
      provider: connector.provider,
      publicNumber: input.publicNumber,
      providerRef: input.providerRef,
      displayLabel: input.displayLabel,
      leadSourceId: input.leadSourceId ?? null,
      sourceDetail: cleanDetail(input.sourceDetail),
      departmentId: input.departmentId ?? null,
    })
    .returning();

  return { ok: true, endpoint: await vmById(db, tenantId, row!.id) };
}

async function findEndpointForConnector(db: Db, tenantId: string, connectorId: string, endpointId: string) {
  const [row] = await selectJoined(db)
    .where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.id, endpointId)))
    .limit(1);
  return row ?? null;
}

export async function updateCommunicationEndpoint(
  db: Db,
  tenantId: string,
  connectorId: string,
  endpointId: string,
  input: UpdateCommunicationEndpointInput,
): Promise<{ ok: true; endpoint: CommunicationEndpointVm } | { ok: false; reason: "endpoint_not_found" | RefReason }> {
  // Scoped to tenant + connector together — an endpoint id that exists but
  // belongs to a different tenant, or to a different connector within the
  // same tenant, must be indistinguishable from one that doesn't exist.
  const existing = await findEndpointForConnector(db, tenantId, connectorId, endpointId);
  if (!existing) return { ok: false, reason: "endpoint_not_found" };
  const bad = await checkReferences(db, tenantId, input);
  if (bad) return { ok: false, reason: bad };

  const updates: Partial<EndpointRow> = {};
  if (input.branchId !== undefined) updates.branchId = input.branchId;
  if (input.displayLabel !== undefined) updates.displayLabel = input.displayLabel;
  if (input.isActive !== undefined) updates.isActive = input.isActive;
  if (input.leadSourceId !== undefined) updates.leadSourceId = input.leadSourceId;
  if (input.sourceDetail !== undefined) updates.sourceDetail = cleanDetail(input.sourceDetail);
  if (input.departmentId !== undefined) updates.departmentId = input.departmentId;

  if (Object.keys(updates).length === 0) return { ok: true, endpoint: toVm(existing) };
  await db
    .update(communicationEndpoints)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(communicationEndpoints.id, endpointId), eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId)));
  return { ok: true, endpoint: await vmById(db, tenantId, endpointId) };
}

export async function resolveEndpointByProviderRef(
  db: Db,
  tenantId: string,
  connectorId: string,
  providerRef: string,
): Promise<CommunicationEndpointVm | null> {
  const [r] = await selectJoined(db)
    .where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.providerRef, providerRef)))
    .limit(1);
  return r ? toVm(r) : null;
}

const digitsTail = (s: string) => s.replace(/\D/g, "").slice(-10);

/**
 * The hospital line a call arrived on, from the number the provider reports (CCS: the IVR / deskphone number). Compared as
 * E.164 in the tenant's region ("079 4000 1234" = "07940001234" = "+917940001234"); a number that will not parse falls back to
 * its last ten digits. Two lines that match the same number (a misconfiguration) resolve to nothing rather than to a guess.
 */
export async function resolveEndpointByCalledNumber(db: Db, tenantId: string, connectorId: string, calledNumber: string | null | undefined): Promise<CommunicationEndpointVm | null> {
  if (!calledNumber || !calledNumber.trim()) return null;
  const region = await resolveDefaultPhoneRegion(db, tenantId);
  const wanted = normalizePhone(calledNumber, region);
  const rows = await selectJoined(db).where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.isActive, true)));
  const hits = rows.filter((r) => {
    const have = normalizePhone(r.endpoint.publicNumber, region);
    if (wanted.e164 && have.e164) return wanted.e164 === have.e164;
    const a = digitsTail(calledNumber);
    return a.length >= 6 && a === digitsTail(r.endpoint.publicNumber);
  });
  return hits.length === 1 ? toVm(hits[0]!) : null;
}

// Runo (and any future telephony provider that doesn't report which line was
// used) can only resolve an endpoint unambiguously when a connector has
// exactly one active one configured — that's a real default, not a guess.
// Two or more candidates means it's genuinely unknown which was used, so
// this returns null rather than picking one arbitrarily.
export async function getSoleActiveEndpointForConnector(db: Db, tenantId: string, connectorId: string): Promise<CommunicationEndpointVm | null> {
  const rows = await selectJoined(db)
    .where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.isActive, true)))
    .limit(2);
  if (rows.length !== 1) return null;
  return toVm(rows[0]!);
}

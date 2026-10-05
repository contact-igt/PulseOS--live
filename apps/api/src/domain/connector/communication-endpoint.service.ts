import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { branchBelongsToTenant } from "../patient/identity.service.js";
import { branches, communicationEndpoints, connectors } from "../../db/schema.js";
import type { CommunicationEndpointVm, CreateCommunicationEndpointInput, UpdateCommunicationEndpointInput } from "@pulseos/types";

type EndpointRow = typeof communicationEndpoints.$inferSelect;

function toVm(row: EndpointRow, connectorProvider: string, branchName: string | null): CommunicationEndpointVm {
  return {
    id: row.id,
    connectorId: row.connectorId,
    connectorProvider,
    branchId: row.branchId,
    branchName,
    type: row.type,
    provider: row.provider,
    publicNumber: row.publicNumber,
    providerRef: row.providerRef,
    displayLabel: row.displayLabel,
    isActive: row.isActive,
  };
}

async function findConnector(db: Db, tenantId: string, connectorId: string) {
  const [row] = await db.select().from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, connectorId))).limit(1);
  return row ?? null;
}

export async function listCommunicationEndpoints(db: Db, tenantId: string, connectorId?: string): Promise<CommunicationEndpointVm[]> {
  const conditions = connectorId
    ? and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId))
    : eq(communicationEndpoints.tenantId, tenantId);

  const rows = await db
    .select({
      endpoint: communicationEndpoints,
      connectorProvider: connectors.provider,
      branchName: branches.name,
    })
    .from(communicationEndpoints)
    .innerJoin(connectors, eq(communicationEndpoints.connectorId, connectors.id))
    .leftJoin(branches, eq(communicationEndpoints.branchId, branches.id))
    .where(conditions)
    .orderBy(communicationEndpoints.displayLabel);

  return rows.map((r) => toVm(r.endpoint, r.connectorProvider, r.branchName ?? null));
}

export async function createCommunicationEndpoint(
  db: Db,
  tenantId: string,
  connectorId: string,
  input: CreateCommunicationEndpointInput,
): Promise<{ ok: true; endpoint: CommunicationEndpointVm } | { ok: false; reason: "connector_not_found" | "provider_ref_already_exists" | "branch_not_found" }> {
  const connector = await findConnector(db, tenantId, connectorId);
  if (!connector) return { ok: false, reason: "connector_not_found" };

  const [existing] = await db
    .select({ id: communicationEndpoints.id })
    .from(communicationEndpoints)
    .where(and(eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.providerRef, input.providerRef)))
    .limit(1);
  if (existing) return { ok: false, reason: "provider_ref_already_exists" };
  if (input.branchId && !(await branchBelongsToTenant(db, tenantId, input.branchId))) return { ok: false, reason: "branch_not_found" };

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
    })
    .returning();

  let branchName: string | null = null;
  if (row!.branchId) {
    const [branch] = await db.select({ name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, row!.branchId))).limit(1);
    branchName = branch?.name ?? null;
  }

  return { ok: true, endpoint: toVm(row!, connector.provider, branchName) };
}

async function findEndpointForConnector(db: Db, tenantId: string, connectorId: string, endpointId: string) {
  const [row] = await db
    .select({ endpoint: communicationEndpoints, connectorProvider: connectors.provider })
    .from(communicationEndpoints)
    .innerJoin(connectors, eq(communicationEndpoints.connectorId, connectors.id))
    .where(
      and(
        eq(communicationEndpoints.tenantId, tenantId),
        eq(communicationEndpoints.connectorId, connectorId),
        eq(communicationEndpoints.id, endpointId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateCommunicationEndpoint(
  db: Db,
  tenantId: string,
  connectorId: string,
  endpointId: string,
  input: UpdateCommunicationEndpointInput,
): Promise<{ ok: true; endpoint: CommunicationEndpointVm } | { ok: false; reason: "endpoint_not_found" | "branch_not_found" }> {
  // Scoped to tenant + connector together — an endpoint id that exists but
  // belongs to a different tenant, or to a different connector within the
  // same tenant, must be indistinguishable from one that doesn't exist.
  const existing = await findEndpointForConnector(db, tenantId, connectorId, endpointId);
  if (!existing) return { ok: false, reason: "endpoint_not_found" };
  if (input.branchId && !(await branchBelongsToTenant(db, tenantId, input.branchId))) return { ok: false, reason: "branch_not_found" };

  const updates: Partial<EndpointRow> = {};
  if (input.branchId !== undefined) updates.branchId = input.branchId;
  if (input.displayLabel !== undefined) updates.displayLabel = input.displayLabel;
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  const row =
    Object.keys(updates).length > 0
      ? (
          await db
            .update(communicationEndpoints)
            .set(updates)
            .where(and(eq(communicationEndpoints.id, endpointId), eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId)))
            .returning()
        )[0]!
      : existing.endpoint;

  let branchName: string | null = null;
  if (row.branchId) {
    const [branch] = await db.select({ name: branches.name }).from(branches).where(and(eq(branches.tenantId, tenantId), eq(branches.id, row.branchId))).limit(1);
    branchName = branch?.name ?? null;
  }

  return { ok: true, endpoint: toVm(row, existing.connectorProvider, branchName) };
}

export async function resolveEndpointByProviderRef(
  db: Db,
  tenantId: string,
  connectorId: string,
  providerRef: string,
): Promise<CommunicationEndpointVm | null> {
  const [r] = await db
    .select({
      endpoint: communicationEndpoints,
      connectorProvider: connectors.provider,
      branchName: branches.name,
    })
    .from(communicationEndpoints)
    .innerJoin(connectors, eq(communicationEndpoints.connectorId, connectors.id))
    .leftJoin(branches, eq(communicationEndpoints.branchId, branches.id))
    .where(
      and(
        eq(communicationEndpoints.tenantId, tenantId),
        eq(communicationEndpoints.connectorId, connectorId),
        eq(communicationEndpoints.providerRef, providerRef),
      ),
    )
    .limit(1);

  if (!r) return null;
  return toVm(r.endpoint, r.connectorProvider, r.branchName ?? null);
}

// Runo (and any future telephony provider that doesn't report which line was
// used) can only resolve an endpoint unambiguously when a connector has
// exactly one active one configured — that's a real default, not a guess.
// Two or more candidates means it's genuinely unknown which was used, so
// this returns null rather than picking one arbitrarily.
export async function getSoleActiveEndpointForConnector(db: Db, tenantId: string, connectorId: string): Promise<CommunicationEndpointVm | null> {
  const rows = await db
    .select({
      endpoint: communicationEndpoints,
      connectorProvider: connectors.provider,
      branchName: branches.name,
    })
    .from(communicationEndpoints)
    .innerJoin(connectors, eq(communicationEndpoints.connectorId, connectors.id))
    .leftJoin(branches, eq(communicationEndpoints.branchId, branches.id))
    .where(and(eq(communicationEndpoints.tenantId, tenantId), eq(communicationEndpoints.connectorId, connectorId), eq(communicationEndpoints.isActive, true)))
    .limit(2);

  if (rows.length !== 1) return null;
  return toVm(rows[0]!.endpoint, rows[0]!.connectorProvider, rows[0]!.branchName ?? null);
}

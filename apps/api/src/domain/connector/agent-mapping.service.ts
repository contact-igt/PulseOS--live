import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectorAgentMappings, connectors, users } from "../../db/schema.js";
import type { ConnectorAgentMappingVm } from "@pulseos/types";

// A provider names its agents however it likes ("Shivi", "Poonam Jain", a number). The key is that name lowercased with runs
// of whitespace collapsed, so "Poonam  Jain" and "poonam jain" are one agent.
export const agentKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: "connector_not_found" | "user_not_found" | "invalid_request" | "mapping_not_found" };

async function ownConnector(db: Db, tenantId: string, connectorId: string) {
  const [c] = await db.select({ id: connectors.id }).from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.id, connectorId))).limit(1);
  return !!c;
}

export async function listAgentMappings(db: Db, tenantId: string, connectorId: string): Promise<ConnectorAgentMappingVm[]> {
  const rows = await db
    .select({ m: connectorAgentMappings, userName: users.name })
    .from(connectorAgentMappings)
    .innerJoin(users, eq(users.id, connectorAgentMappings.userId))
    .where(and(eq(connectorAgentMappings.tenantId, tenantId), eq(connectorAgentMappings.connectorId, connectorId)))
    .orderBy(connectorAgentMappings.externalAgent);
  return rows.map((r) => ({ id: r.m.id, connectorId: r.m.connectorId, externalAgent: r.m.externalAgent, userId: r.m.userId, userName: r.userName }));
}

/** Creates or re-points the mapping for one provider agent. The user must belong to the same tenant. */
export async function setAgentMapping(db: Db, tenantId: string, connectorId: string, input: { externalAgent: string; userId: string }): Promise<Result<{ mapping: ConnectorAgentMappingVm }>> {
  const externalAgent = input.externalAgent?.trim().replace(/\s+/g, " ");
  if (!externalAgent || externalAgent.length > 80) return { ok: false, reason: "invalid_request" };
  if (!(await ownConnector(db, tenantId, connectorId))) return { ok: false, reason: "connector_not_found" };
  const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, input.userId))).limit(1);
  if (!u) return { ok: false, reason: "user_not_found" };
  const [row] = await db
    .insert(connectorAgentMappings)
    .values({ tenantId, connectorId, externalAgent, externalKey: agentKey(externalAgent), userId: u.id })
    .onConflictDoUpdate({ target: [connectorAgentMappings.connectorId, connectorAgentMappings.externalKey], set: { externalAgent, userId: u.id } })
    .returning();
  return { ok: true, mapping: { id: row!.id, connectorId, externalAgent: row!.externalAgent, userId: u.id, userName: u.name } };
}

export async function deleteAgentMapping(db: Db, tenantId: string, connectorId: string, mappingId: string): Promise<Result> {
  const gone = await db
    .delete(connectorAgentMappings)
    .where(and(eq(connectorAgentMappings.tenantId, tenantId), eq(connectorAgentMappings.connectorId, connectorId), eq(connectorAgentMappings.id, mappingId)))
    .returning({ id: connectorAgentMappings.id });
  return gone.length ? { ok: true } : { ok: false, reason: "mapping_not_found" };
}

/** The team member a provider agent maps to, or null (an unmapped agent is simply recorded by name). */
export async function resolveMappedUser(db: Db, tenantId: string, connectorId: string, agentName: string | null | undefined): Promise<string | null> {
  if (!agentName || !agentName.trim()) return null;
  const [m] = await db
    .select({ userId: connectorAgentMappings.userId })
    .from(connectorAgentMappings)
    .where(and(eq(connectorAgentMappings.tenantId, tenantId), eq(connectorAgentMappings.connectorId, connectorId), eq(connectorAgentMappings.externalKey, agentKey(agentName))))
    .limit(1);
  return m?.userId ?? null;
}

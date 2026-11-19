import { isDeepStrictEqual } from "node:util";
import { and, asc, count, eq, gt, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "../../db/client.js";
import { connectorEvents, connectors, connectorSecrets, hospitalLifecycleAudit, suspendedMetaLeads as held, tenants } from "../../db/schema.js";
import { hospitalIsActive } from "../tenant/hospital-lifecycle.policy.js";
import { getConnectorById, getConnectorSecrets } from "../connector/connector.service.js";
import { getAcquisitionAdapter } from "../connector/registry.js";
import { processMetaLead } from "./lead-webhook.service.js";
import type { LeadReference, NormalizedLead } from "./types.js";

const idShape = /^[0-9]{1,64}$/;
const limit = 1000;

function pageMatches(connector: Pick<typeof connectors.$inferSelect, "configuration" | "mode">, page: string | null | undefined) {
  const expected = (connector.configuration as Record<string, unknown> | null)?.leadPageId;
  return typeof expected === "string" && expected.length > 0 ? expected === page : connector.mode === "FIXTURE";
}

export async function admitMetaLead(db: Db, tenantId: string, connectorId: string, ref: LeadReference,
  verify: (secrets: Record<string, unknown>) => boolean,
  prepared?: { connector: typeof connectors.$inferSelect; secrets: Record<string, unknown>; lead: NormalizedLead }) {
  return db.transaction(async (tx) => {
    // Serializes the admission decision with suspension and limits the tenant's holding queue under concurrency.
    const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
    const [connector] = await tx.select().from(connectors).where(and(
      eq(connectors.id, connectorId), eq(connectors.tenantId, tenantId), eq(connectors.provider, "meta_lead_ads"),
      sql`${connectors.status} <> 'DISABLED'`,
    )).for("share");
    if (!tenant || !connector || !pageMatches(connector, ref.externalPageId)) return "unavailable";
    const secrets = await currentSecrets(tx, connectorId);
    if (!secrets || !verify(secrets)) return "unavailable";
    const key = and(eq(held.tenantId, tenantId), eq(held.connectorId, connectorId), eq(held.externalLeadId, ref.externalLeadId));
    const [existing] = await tx.select({ id: held.externalLeadId, expiresAt: held.expiresAt }).from(held).where(key);
    if (existing) return existing.expiresAt > new Date() ? "held" : "unavailable";
    const [prior] = await tx.select({ id: connectorEvents.id }).from(connectorEvents).where(and(
      eq(connectorEvents.tenantId, tenantId), eq(connectorEvents.connectorId, connectorId),
      eq(connectorEvents.externalEventId, ref.externalLeadId), eq(connectorEvents.status, "processed"),
    )).limit(1);
    if (prior) return "processed";
    if (hospitalIsActive(tenant)) {
      if (!prepared) return "fetch";
      if (!sameBinding(connector, prepared.connector, secrets, prepared.secrets)) return "unavailable";
      await processMetaLead(tx, tenantId, connectorId, prepared.lead);
      return "processed";
    }
    if (tenant.lifecycleStatus !== "SUSPENDED" || !idShape.test(ref.externalLeadId) || !Number.isFinite(ref.occurredAt.getTime()) ||
      [ref.externalAdId, ref.externalAdGroupId, ref.externalFormId, ref.externalPageId ?? null]
        .some((id) => id !== null && !idShape.test(id))) return "unavailable";
    const [size] = await tx.select({ total: count() }).from(held)
      .where(and(eq(held.tenantId, tenantId), gt(held.expiresAt, new Date())));
    if (size!.total >= limit) return "unavailable";
    await tx.insert(held).values({ tenantId, connectorId, externalLeadId: ref.externalLeadId, reference: {
      page: ref.externalPageId ?? null, form: ref.externalFormId, group: ref.externalAdGroupId, ad: ref.externalAdId, at: ref.occurredAt.toISOString(),
    } }).onConflictDoNothing();
    return "held";
  });
}

type MetaConnector = typeof connectors.$inferSelect;

function sameBinding(current: MetaConnector, snapshot: MetaConnector, secrets: Record<string, unknown>, snapshotSecrets: Record<string, unknown>) {
  return current.mode === snapshot.mode && isDeepStrictEqual(current.configuration, snapshot.configuration) &&
    isDeepStrictEqual(secrets, snapshotSecrets);
}

export async function fetchBoundMetaLead(connector: MetaConnector, secrets: Record<string, unknown>, ref: LeadReference) {
  if (!pageMatches(connector, ref.externalPageId)) throw new Error("page_binding_mismatch");
  const adapter = getAcquisitionAdapter("meta_lead_ads");
  if (!adapter?.fetchLead) throw new Error("connector_unavailable");
  const lead = await adapter.fetchLead(ref, { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase() }, secrets);
  if (lead.externalLeadId !== ref.externalLeadId) throw new Error("lead_identity_mismatch");
  return lead;
}

async function currentSecrets(tx: Tx, connectorId: string) {
  const [row] = await tx.select({ id: connectorSecrets.connectorId }).from(connectorSecrets)
    .where(eq(connectorSecrets.connectorId, connectorId)).for("share");
  return row ? getConnectorSecrets(tx, connectorId) : null;
}

export async function replayHeldMetaLeads(db: Db, tenantId: string, actorId: string, version: number) {
  const [initial] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!initial || !hospitalIsActive(initial) || initial.lifecycleVersion !== version) return null;
  await db.insert(hospitalLifecycleAudit).values({ tenantId, targetId: tenantId, actorId, action: "replay_meta_leads_requested",
    previousState: initial.lifecycleStatus, requestedState: initial.lifecycleStatus, outcome: "approved", requestVersion: version });
  const now = new Date();
  const rows = await db.select({ connectorId: held.connectorId, leadId: held.externalLeadId, reference: held.reference }).from(held)
    .where(and(eq(held.tenantId, tenantId), isNotNull(held.reference), gt(held.expiresAt, now),
      lte(held.nextAttemptAt, now), lt(held.attempts, 3))).orderBy(asc(held.heldAt), asc(held.externalLeadId)).limit(5);
  const tally = { processed: 0, failed: 0, skipped: 0 };
  for (const candidate of rows) {
    const snapshot = await getConnectorById(db, candidate.connectorId);
    const snapshotSecrets = snapshot?.tenantId === tenantId && snapshot.provider === "meta_lead_ads" && snapshot.status !== "DISABLED"
      ? await getConnectorSecrets(db, candidate.connectorId) : null;
    let lead: NormalizedLead | undefined;
    if (snapshot && snapshotSecrets && candidate.reference) {
      const ref = candidate.reference;
      try {
        lead = await fetchBoundMetaLead(snapshot, snapshotSecrets, {
          externalLeadId: candidate.leadId, externalPageId: ref.page, externalFormId: ref.form,
          externalAdGroupId: ref.group, externalAdId: ref.ad, occurredAt: new Date(ref.at),
        });
      } catch {
        // Record bounded backoff only after checking this reference and lifecycle again.
      }
    }
    const result = await db.transaction(async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
      if (!tenant || !hospitalIsActive(tenant) || tenant.lifecycleVersion !== version) return "skipped" as const;
      const key = and(eq(held.tenantId, tenantId), eq(held.connectorId, candidate.connectorId), eq(held.externalLeadId, candidate.leadId));
      const [row] = await tx.select().from(held).where(key).for("update");
      if (!row?.reference || row.expiresAt <= new Date() || row.nextAttemptAt > new Date() || row.attempts >= 3) return "skipped" as const;
      const [connector] = await tx.select().from(connectors).where(and(eq(connectors.id, row.connectorId),
        eq(connectors.tenantId, tenantId), eq(connectors.provider, "meta_lead_ads"), sql`${connectors.status} <> 'DISABLED'`)).for("share");
      let outcome: "processed" | "failed" = "failed";
      try {
        const secrets = connector ? await currentSecrets(tx, connector.id) : null;
        if (!isDeepStrictEqual(row.reference, candidate.reference)) return "skipped" as const;
        if (secrets && connector && (!snapshot || !snapshotSecrets ||
          !sameBinding(connector, snapshot, secrets, snapshotSecrets))) return "skipped" as const;
        if (!connector || !secrets || !lead || !pageMatches(connector, row.reference.page)) throw new Error("connector_unavailable");
        const fetchedLead = lead;
        await tx.transaction((work) => processMetaLead(work, tenantId, connector.id, fetchedLead));
        await tx.update(held).set({ reference: null }).where(key);
        outcome = "processed";
      } catch {
        await tx.update(held).set({ attempts: row.attempts + 1,
          nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** row.attempts) }).where(key);
      }
      await tx.insert(hospitalLifecycleAudit).values({ tenantId, targetId: tenantId, actorId, action: "replay_meta_lead",
        previousState: tenant.lifecycleStatus, requestedState: tenant.lifecycleStatus, outcome });
      return outcome;
    });
    tally[result]++;
  }
  return tally;
}

export async function purgeExpiredMetaLeads(db: Db, now: Date) {
  await db.execute(sql`delete from ${held} where (${held.connectorId}, ${held.externalLeadId}) in
    (select ${held.connectorId}, ${held.externalLeadId} from ${held} where ${lte(held.expiresAt, now)}
      order by ${held.expiresAt} limit 500 for update skip locked)`);
}

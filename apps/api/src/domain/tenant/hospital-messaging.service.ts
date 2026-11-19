import { and, count, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../../db/client.js";
import { connectors, connectorSecrets, hospitalLifecycleAudit, hospitalMessagingCommands as commands, platformAccounts, tenants } from "../../db/schema.js";
import type { PlatformActor } from "../platform/platform-access.js";

const commandResponse = z.object({
  state: z.enum(["ACTIVE", "PAUSING", "PAUSED"]),
  version: z.number().int().min(0).max(2147483647),
});
const providerState = commandResponse.extend({
  lastCommand: z.string().uuid().nullable(),
  openPermits: z.array(z.object({ id: z.string().uuid() })).max(50),
  permits: z.array(z.object({ state: z.string(), count: z.coerce.number().int().nonnegative() })),
});
const partnerBinding = z.object({
  success: z.literal(true),
  data: z.object({ enabled: z.literal(true), pulseosTenantId: z.string().uuid(), hasApiKey: z.literal(true), hasCallbackSecret: z.literal(true) }),
});
type Command = typeof commands.$inferSelect;
type ProviderState = z.infer<typeof providerState>;
const maxAttempts = 8;
export const HOSPITAL_MESSAGING_ALERT_AGE_MS = 15 * 60_000;

export const messagingCoordinationEnabled = () => process.env.WHATSNEXUS_MANAGEMENT_ENABLED === "true";

export async function countAgedHospitalMessagingCommands(db: Db, now: Date) {
  if (!messagingCoordinationEnabled()) return 0;
  const [aged] = await db.select({ total: count() }).from(commands).where(and(
    eq(commands.status, "pending"), lte(commands.createdAt, new Date(now.getTime() - HOSPITAL_MESSAGING_ALERT_AGE_MS)),
  ));
  return aged?.total ?? 0;
}

function origin(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

async function pairedConnector(db: DbOrTx, tenantId: string, lock = true) {
  const binding = db.select({ id: connectors.id, status: connectors.status, configuration: connectors.configuration }).from(connectors)
    .where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "whatsnexus"), eq(connectors.mode, "LIVE")));
  const [row] = await (lock ? binding.for("share") : binding);
  if (!row || row.status === "DISABLED") return null;
  const revision = db.select({ updatedAt: connectorSecrets.updatedAt }).from(connectorSecrets)
    .where(eq(connectorSecrets.connectorId, row.id));
  const [secret] = await (lock ? revision.for("share") : revision);
  if (!secret) return null;
  const config = z.object({ tenantId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), baseUrl: z.string() }).safeParse(row.configuration);
  const partnerOrigin = config.success && origin(config.data.baseUrl);
  if (!partnerOrigin || !config.success) return null;
  return { connectorId: row.id, remoteTenantId: config.data.tenantId, partnerOrigin, pairingRevision: secret.updatedAt };
}

export async function enqueueMessagingPause(db: DbOrTx, tenantId: string, lifecycleVersion: number, actor: string) {
  if (!messagingCoordinationEnabled()) return;
  const pairing = await pairedConnector(db, tenantId);
  if (pairing) await db.insert(commands).values({
    ...pairing, tenantId, lifecycleVersion, actor, action: "pause",
  }).onConflictDoNothing();
}

export async function requestMessagingAction(db: Db, tenantId: string, targetId: string, version: number,
  actor: PlatformActor, action: "retry" | "resume", permissions: readonly string[]) {
  if (!messagingCoordinationEnabled()) return "coordination_disabled";
  return db.transaction(async (tx) => {
    const [hospital] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("update");
    if (!hospital || hospital.lifecycleVersion !== version) return "lifecycle_version_conflict";
    const permission = action === "resume" || hospital.lifecycleStatus === "ACTIVE" ? "hospital:restore" : "hospital:suspend";
    if (!permissions.includes(permission)) return "forbidden";
    const audit = () => tx.insert(hospitalLifecycleAudit).values({
      tenantId, targetId, actorId: actor.kind === "browser" ? actor.id : null, operatorId: actor.kind === "operator" ? actor.id : null,
      action: "whatsnexus_" + action, previousState: hospital.lifecycleStatus, requestedState: hospital.lifecycleStatus,
      requestVersion: version, outcome: "queued",
    });
    const [latest] = await tx.select().from(commands).where(eq(commands.tenantId, tenantId))
      .orderBy(desc(commands.createdAt), desc(commands.id)).limit(1);
    if (action === "retry") {
      if (!latest || latest.status !== "failed") return "command_not_retryable";
      const retryCurrent = latest.lifecycleVersion === version &&
        hospital.lifecycleStatus === (latest.action === "pause" ? "SUSPENDED" : "ACTIVE");
      const observePriorPause = hospital.lifecycleStatus === "ACTIVE" && latest.action === "pause" && latest.expectedVersion !== null;
      if (!retryCurrent && !observePriorPause) return "command_not_retryable";
      await tx.update(commands).set({
        status: "pending", attempts: 0, dueAt: new Date(), error: null,
        ...(latest.action === "resume" ? { actor: actor.id } : {}),
      }).where(eq(commands.id, latest.id));
      await audit();
      return null;
    }
    if (hospital.lifecycleStatus !== "ACTIVE") return "hospital_not_restored";
    if (latest?.action === "resume" && latest.lifecycleVersion === version) return null;
    const pairing = await pairedConnector(tx, tenantId);
    if (!pairing || !latest || latest.action !== "pause" || latest.status !== "confirmed" || !samePairing(latest, pairing)) return "pause_not_confirmed";
    const verifiedPause = z.object({ state: z.literal("PAUSED"), version: z.number().int().nonnegative() }).safeParse(latest.observation);
    if (!verifiedPause.success) return "pause_not_confirmed";
    await tx.insert(commands).values({
      ...pairing, tenantId, lifecycleVersion: version, actor: actor.id, action: "resume", expectedVersion: verifiedPause.data.version,
    }).onConflictDoNothing();
    await audit();
    return null;
  });
}

function samePairing(command: Pick<Command, "connectorId" | "remoteTenantId" | "partnerOrigin" | "pairingRevision">,
  pairing: NonNullable<Awaited<ReturnType<typeof pairedConnector>>>) {
  return command.connectorId === pairing.connectorId && command.remoteTenantId === pairing.remoteTenantId &&
    command.partnerOrigin === pairing.partnerOrigin && +command.pairingRevision === +pairing.pairingRevision;
}

class CoordinationFailure extends Error {
  constructor(readonly code: string, readonly retry: boolean) { super(code); }
}

function managementClient(command: Command, transport: typeof fetch) {
  const endpoint = origin(process.env.WHATSNEXUS_MANAGEMENT_ORIGIN);
  const token = process.env.WHATSNEXUS_MANAGEMENT_JWT?.trim();
  if (!endpoint || endpoint !== command.partnerOrigin || !token) throw new CoordinationFailure("management_not_configured", false);
  const base = endpoint + "/api/management/integrations/pulseos/" + encodeURIComponent(command.remoteTenantId);
  return async (suffix: string, body?: object) => {
    let response: Response;
    try {
      response = await transport(base + suffix, {
        method: body ? "POST" : "GET",
        headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(2500), redirect: "error", cache: "no-store",
      });
    } catch {
      throw new CoordinationFailure("provider_unavailable", true);
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? "management_unauthorized"
        : response.status === 404 ? "pairing_mismatch" : response.status === 409 ? "provider_version_or_pairing_conflict"
        : "provider_rejected";
      throw new CoordinationFailure(code, response.status >= 500 || [408, 429].includes(response.status));
    }
    try { return await response.json() as unknown; }
    catch { throw new CoordinationFailure("invalid_provider_response", true); }
  };
}

function readProviderState(value: unknown) {
  const parsed = providerState.safeParse(value);
  if (!parsed.success) throw new CoordinationFailure("invalid_provider_response", true);
  return parsed.data;
}

function observation(value: ProviderState) {
  return { state: value.state, version: value.version, lastCommand: value.lastCommand,
    unresolvedPermits: value.permits.filter(({ state }) => state === "sending" || state === "unknown")
      .reduce((total, { count }) => total + count, 0) };
}

function requireFreshStatus(remote: ProviderState, previous: unknown, minimumVersion: number) {
  const prior = commandResponse.safeParse(previous);
  if (remote.version < minimumVersion || (prior.success && (
    remote.version < prior.data.version ||
    (remote.version === prior.data.version && remote.state !== prior.data.state &&
      !(prior.data.state === "PAUSING" && remote.state === "PAUSED"))
  ))) throw new CoordinationFailure("stale_provider_status", true);
}

export async function processHospitalMessagingCommands(db: Db, now: Date, transport: typeof fetch = fetch,
  warn?: (event: { commandId: string; hospitalId: string; classification: string; attempts: number; terminal: boolean; unresolvedPermits: number }) => void) {
  if (!messagingCoordinationEnabled()) return;
  const due = await db.select({ id: commands.id, tenantId: commands.tenantId }).from(commands)
    .where(and(eq(commands.status, "pending"), lte(commands.dueAt, now))).orderBy(commands.dueAt).limit(5);
  for (const candidate of due) {
    // Hold the hospital lock over bounded provider calls so lifecycle/command writes agree on ordering.
    // Persist expectedVersion in a separate committed step before any POST.
    const warning = await db.transaction(async (tx) => {
      const [hospital] = await tx.select().from(tenants).where(eq(tenants.id, candidate.tenantId)).for("update");
      const [command] = await tx.select().from(commands).where(eq(commands.id, candidate.id)).for("update");
      if (!hospital || !command || command.status !== "pending" || command.dueAt > now) return;
      const save = (patch: Partial<typeof commands.$inferInsert>) => tx.update(commands).set(patch).where(eq(commands.id, command.id));
      const current = hospital.lifecycleVersion === command.lifecycleVersion &&
        hospital.lifecycleStatus === (command.action === "pause" ? "SUSPENDED" : "ACTIVE");
      const observePriorPause = hospital.lifecycleStatus === "ACTIVE" && command.action === "pause" && command.expectedVersion !== null;
      if (!current && !observePriorPause) {
        await save({ status: "superseded", error: "lifecycle_changed" });
        return;
      }
      const attempts = command.attempts + 1;
      const dueAt = new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6)));
      const defer = async (error: string, retry: boolean, unresolvedPermits = 0) => {
        const terminal = !retry || attempts >= maxAttempts;
        await save({ status: terminal ? "failed" : "pending", dueAt, attempts, error });
        if (terminal || (error === "provider_unavailable" && attempts === 3) ||
          (error === "provider_pausing" && unresolvedPermits > 0 && command.error !== error)) {
          return { commandId: command.id, hospitalId: command.tenantId, classification: error, attempts, terminal, unresolvedPermits };
        }
      };
      try {
        const pairing = await pairedConnector(tx, command.tenantId);
        if (!pairing || !samePairing(command, pairing)) throw new CoordinationFailure("pairing_changed", false);
        if (command.action === "resume") {
          const [actor] = await tx.select().from(platformAccounts).where(eq(platformAccounts.id, command.actor)).for("share");
          if (!actor || actor.role !== "PLATFORM_SUPER_ADMIN" || actor.disabledAt || !actor.mfaSecret) {
            throw new CoordinationFailure("operator_authorization_changed", false);
          }
        }
        const fetchManagement = managementClient(command, transport);
        const verifyBinding = async () => {
          const binding = partnerBinding.safeParse(await fetchManagement(""));
          if (!binding.success || binding.data.data.pulseosTenantId !== command.tenantId) throw new CoordinationFailure("pairing_mismatch", false);
        };
        await verifyBinding();
        const status = async () => {
          const remote = readProviderState(await fetchManagement("/messaging-status"));
          await verifyBinding();
          return remote;
        };
        let remote = await status();
        const acknowledged = commandResponse.safeParse(command.acknowledgement);
        requireFreshStatus(remote, command.observation, Math.max(
          command.expectedVersion ?? 0, acknowledged.success ? acknowledged.data.version : 0,
        ));
        const desired = command.action === "pause" ? "PAUSED" : "ACTIVE";
        await save({ observation: observation(remote), verifiedAt: new Date() });
        if (remote.state !== desired && current && remote.state !== "PAUSING") {
          if (command.expectedVersion === null) {
            await save({ expectedVersion: remote.version, dueAt: now, error: null });
            return;
          }
          if (remote.version !== command.expectedVersion) throw new CoordinationFailure("provider_version_or_pairing_conflict", false);
          const acknowledgement = commandResponse.safeParse(await fetchManagement("/messaging-" + command.action, {
            commandId: command.id, expectedVersion: command.expectedVersion, lifecycleVersion: command.lifecycleVersion,
            pulseosTenantId: command.tenantId, reason: "HOSPITAL_LIFECYCLE",
          }));
          if (!acknowledgement.success) throw new CoordinationFailure("invalid_provider_response", true);
          await save({ acknowledgement: acknowledgement.data });
          const refreshed = await status();
          requireFreshStatus(refreshed, remote, acknowledgement.data.version);
          remote = refreshed;
          await save({ observation: observation(remote), verifiedAt: new Date() });
        }
        if (remote.state === desired) await save({ status: "confirmed", attempts, error: null });
        else return defer(remote.state === "PAUSING" ? "provider_pausing" : "provider_state_unconfirmed", true, observation(remote).unresolvedPermits);
      } catch (error) {
        if (!(error instanceof CoordinationFailure)) throw error;
        return defer(error.code, error.retry);
      }
    });
    if (warning) warn?.(warning);
  }
}

export async function sampleAgedHospitalMessagingCommands(db: Db, now: Date) {
  if (!messagingCoordinationEnabled()) return [];
  return db.select({ commandId: commands.id, hospitalId: commands.tenantId }).from(commands)
    .where(and(eq(commands.status, "pending"), lte(commands.createdAt, new Date(+now - HOSPITAL_MESSAGING_ALERT_AGE_MS))))
    .orderBy(commands.createdAt, commands.id).limit(10);
}

export async function readMessagingCoordination(db: DbOrTx, tenantId: string) {
  const enabled = messagingCoordinationEnabled();
  const rows = await db.select({
    id: commands.id, action: commands.action, actor: commands.actor, status: commands.status, error: commands.error,
    lifecycleVersion: commands.lifecycleVersion, expectedVersion: commands.expectedVersion, attempts: commands.attempts,
    observation: commands.observation, verifiedAt: commands.verifiedAt, createdAt: commands.createdAt,
    connectorId: commands.connectorId, remoteTenantId: commands.remoteTenantId,
    partnerOrigin: commands.partnerOrigin, pairingRevision: commands.pairingRevision,
  }).from(commands).where(eq(commands.tenantId, tenantId)).orderBy(desc(commands.createdAt), desc(commands.id)).limit(10);
  const pairing = enabled && rows[0] ? await pairedConnector(db, tenantId, false) : null;
  const bindingCurrent = !enabled || !rows[0] || Boolean(pairing && samePairing(rows[0], pairing));
  const history = rows.map(({ id, action, actor, status, error, lifecycleVersion, expectedVersion, attempts, observation, verifiedAt, createdAt }) =>
    ({ id, action, actor, status, error, lifecycleVersion, expectedVersion, attempts, observation, verifiedAt, createdAt }));
  return { enabled, bindingCurrent, latest: history[0] ?? null, history };
}

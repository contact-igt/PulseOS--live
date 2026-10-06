import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../../db/client.js";
import { calls, communicationEndpoints, connectorEvents, journeys, leadSources, patients, tasks, users } from "../../db/schema.js";
import type { PayloadShapes, TelephonyCallDetail, TelephonyCallRecord } from "@pulseos/types";
import { isRecognisedCcsField } from "../connector/adapters/ccs-normalizer.js";
import { isCredentialName } from "../../lib/credential-redaction.js";
import { leaves } from "../../lib/payload-shape.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const handler = alias(users, "handler");

// One select for the list and the detail: the call plus the names of what it points at. The recording URL is never selected
// as a value, only whether one exists: playback goes through GET /calls/:id/recording, which authorizes tenant and role.
function selectCalls(db: Db) {
  return db
    .select({
      id: calls.id,
      phone: calls.phone,
      direction: calls.direction,
      status: calls.status,
      durationSeconds: calls.durationSeconds,
      hasRecording: sql<boolean>`${calls.recordingUrl} is not null`,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      journeyId: calls.journeyId,
      patientId: calls.patientId,
      patientName: patients.name,
      agentName: calls.agentName,
      handledByName: handler.name,
      lineLabel: communicationEndpoints.displayLabel,
      sourceLabel: leadSources.label,
      sourceDetail: journeys.sourceDetail,
      externalCallId: calls.externalCallId,
      disposition: calls.disposition,
      metadata: calls.metadata,
    })
    .from(calls)
    .leftJoin(patients, eq(patients.id, calls.patientId))
    .leftJoin(handler, eq(handler.id, calls.handledByUserId))
    .leftJoin(communicationEndpoints, eq(communicationEndpoints.id, calls.communicationEndpointId))
    .leftJoin(journeys, eq(journeys.id, calls.journeyId))
    .leftJoin(leadSources, eq(leadSources.id, journeys.sourceId));
}
type CallRow = Awaited<ReturnType<ReturnType<typeof selectCalls>["limit"]>>[number];

/** The open callback each Journey is waiting on (the earliest-due pending CALLBACK), keyed by journey id. */
async function nextActions(db: Db, tenantId: string, journeyIds: string[]): Promise<Map<string, TelephonyCallRecord["nextAction"]>> {
  const out = new Map<string, TelephonyCallRecord["nextAction"]>();
  if (journeyIds.length === 0) return out;
  const rows = await db
    .select({ id: tasks.id, journeyId: tasks.journeyId, type: tasks.type, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), inArray(tasks.journeyId, journeyIds), eq(tasks.status, "pending"), eq(tasks.type, "CALLBACK")))
    .orderBy(tasks.dueAt);
  for (const r of rows) if (r.journeyId && !out.has(r.journeyId)) out.set(r.journeyId, { taskId: r.id, type: r.type, dueAt: r.dueAt.toISOString() });
  return out;
}

const meta = (m: unknown, k: string): string | null => {
  const v = m && typeof m === "object" ? (m as Record<string, unknown>)[k] : null;
  return v === null || v === undefined || v === "" ? null : String(v);
};

function toRecord(c: CallRow, next: TelephonyCallRecord["nextAction"]): TelephonyCallRecord {
  return {
    id: c.id,
    phone: c.phone,
    direction: c.direction,
    status: c.status,
    durationSeconds: c.durationSeconds,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    hasRecording: c.hasRecording,
    journeyId: c.journeyId,
    patientId: c.patientId,
    patientName: c.patientName,
    agentName: c.agentName,
    handledByName: c.handledByName,
    lineLabel: c.lineLabel,
    sourceLabel: c.sourceLabel,
    nextAction: next,
    // Simulated by "Send test call event" (flagged in metadata; older ones are recognised by their generated id).
    isTest: meta(c.metadata, "simulated") === "true" || (c.externalCallId ?? "").startsWith("test-call-"),
  };
}

export async function listRecentCalls(db: Db, tenantId: string, connectorId: string, limit = 15): Promise<TelephonyCallRecord[]> {
  const rows = await selectCalls(db).where(and(eq(calls.tenantId, tenantId), eq(calls.connectorId, connectorId))).orderBy(desc(calls.startedAt)).limit(limit);
  const next = await nextActions(db, tenantId, rows.map((r) => r.journeyId).filter((j): j is string => !!j));
  return rows.map((r) => toRecord(r, r.journeyId ? next.get(r.journeyId) ?? null : null));
}

export async function getTelephonyCallDetail(db: Db, tenantId: string, connectorId: string, callId: string): Promise<TelephonyCallDetail | null> {
  if (!UUID.test(callId)) return null;
  const [c] = await selectCalls(db).where(and(eq(calls.tenantId, tenantId), eq(calls.connectorId, connectorId), eq(calls.id, callId))).limit(1);
  if (!c) return null;
  const next = c.journeyId ? (await nextActions(db, tenantId, [c.journeyId])).get(c.journeyId) ?? null : null;
  return {
    ...toRecord(c, next),
    providerCallId: c.externalCallId,
    providerLabel: meta(c.metadata, "provider") === "ccs_ivr" ? "CCS Express IVR" : meta(c.metadata, "provider"),
    calledLine: meta(c.metadata, "calledLine"),
    callGroup: meta(c.metadata, "callGroup"),
    circle: meta(c.metadata, "circle"),
    ivrSelection: meta(c.metadata, "ivrSelection"),
    providerStatus: meta(c.metadata, "providerDisposition") ?? c.disposition,
    answeredAt: meta(c.metadata, "answeredAt"),
    endedAt: c.endedAt ? c.endedAt.toISOString() : null,
    sourceDetail: c.sourceDetail,
  };
}

/**
 * What real CCS call reports actually carry, so the first real payload can be mapped from facts instead of guesses.
 * Field names (credential-named ones left out) with how often each was seen and whether PulseOS already maps it, plus the
 * distinct values of category-like fields. Test calls and simulated events are excluded.
 */
export async function getPayloadShapes(db: Db, tenantId: string, connectorId: string, limit = 100): Promise<PayloadShapes> {
  const rows = await db
    .select({ payload: connectorEvents.payload })
    .from(connectorEvents)
    .where(and(eq(connectorEvents.tenantId, tenantId), eq(connectorEvents.connectorId, connectorId), sql`coalesce(${connectorEvents.payload}->>'test', 'false') <> 'true'`))
    .orderBy(desc(connectorEvents.receivedAt))
    .limit(limit);
  const seen = new Map<string, number>();
  const values = new Map<string, Set<string>>();
  for (const { payload } of rows) {
    const raw = (payload as { raw?: unknown } | null)?.raw;
    if (!raw || typeof raw !== "object") continue;
    const seenHere = new Set<string>();
    for (const leaf of leaves(raw)) {
      if (isCredentialName(leaf.path.split(/[.\[\]]+/).filter(Boolean).pop() ?? leaf.path)) continue;
      if (!seenHere.has(leaf.path)) {
        seenHere.add(leaf.path);
        seen.set(leaf.path, (seen.get(leaf.path) ?? 0) + 1);
      }
      if (leaf.value !== null) {
        const set = values.get(leaf.path) ?? new Set<string>();
        if (set.size < 20) set.add(leaf.value);
        values.set(leaf.path, set);
      }
    }
  }
  return {
    events: rows.length,
    // The normalizer reads TOP-LEVEL names only, so a nested name is never "recognised".
    fields: [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, seen: n, recognised: !/[.\[]/.test(name) && isRecognisedCcsField(name) })),
    values: Object.fromEntries([...values.entries()].map(([k, set]) => [k, [...set]])),
  };
}

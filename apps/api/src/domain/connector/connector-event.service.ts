import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { connectorEvents } from "../../db/schema.js";

export interface RecordEventInput {
  tenantId: string;
  connectorId: string;
  externalEventId: string;
  direction: "inbound" | "outbound";
  payload?: unknown;
}

/** A delivery still 'received' this long after it arrived was abandoned (the worker died); a retry may take it over. */
const STALE_RECEIVED_MINUTES = 10;

// The unique (connectorId, externalEventId) index is the actual idempotency
// guard. A second webhook delivery for the same provider event id is a
// duplicate and must not be processed again — callers skip all further side
// effects when duplicate is true. Two exceptions, because dropping them loses the
// lead/call/message for good: a delivery whose processing FAILED, and one
// abandoned mid-way ('received' for longer than STALE_RECEIVED_MINUTES). A
// provider retry of either is claimed — atomically, so racing retries process it
// once — and reprocessed on the same row.
export async function recordConnectorEvent(db: Db, input: RecordEventInput): Promise<{ eventId: string; duplicate: boolean }> {
  const [existing] = await db
    .select({ id: connectorEvents.id })
    .from(connectorEvents)
    .where(and(eq(connectorEvents.connectorId, input.connectorId), eq(connectorEvents.externalEventId, input.externalEventId)))
    .limit(1);

  if (existing) {
    // The state check is inside the UPDATE itself, so of several racing retries exactly one matches and wins the claim.
    const stale = sql`${connectorEvents.receivedAt} < now() - make_interval(mins => ${STALE_RECEIVED_MINUTES})`;
    const claimable = or(eq(connectorEvents.status, "failed"), and(eq(connectorEvents.status, "received"), stale));
    const claimed = await db
      .update(connectorEvents)
      .set({ status: "received", error: null, receivedAt: sql`now()`, processedAt: null })
      .where(and(eq(connectorEvents.id, existing.id), claimable))
      .returning({ id: connectorEvents.id });
    return { eventId: existing.id, duplicate: claimed.length === 0 };
  }

  try {
    const [row] = await db
      .insert(connectorEvents)
      .values({
        tenantId: input.tenantId,
        connectorId: input.connectorId,
        externalEventId: input.externalEventId,
        direction: input.direction,
        status: "received",
        payload: input.payload,
      })
      .returning({ id: connectorEvents.id });
    return { eventId: row.id, duplicate: false };
  } catch {
    // Race: two concurrent deliveries of the same event both passed the SELECT
    // above before either INSERT committed. The unique index still protects
    // us — treat the loser as a duplicate rather than surfacing a 500.
    const [row] = await db
      .select({ id: connectorEvents.id })
      .from(connectorEvents)
      .where(and(eq(connectorEvents.connectorId, input.connectorId), eq(connectorEvents.externalEventId, input.externalEventId)))
      .limit(1);
    return { eventId: row!.id, duplicate: true };
  }
}

export async function markEventProcessed(db: Db, eventId: string): Promise<void> {
  await db.update(connectorEvents).set({ status: "processed", processedAt: new Date() }).where(eq(connectorEvents.id, eventId));
}

export async function markEventFailed(db: Db, eventId: string, error: string): Promise<void> {
  await db.update(connectorEvents).set({ status: "failed", error, processedAt: new Date() }).where(eq(connectorEvents.id, eventId));
}

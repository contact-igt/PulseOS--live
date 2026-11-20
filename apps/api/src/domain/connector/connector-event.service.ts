import { and, eq, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
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
export async function recordConnectorEvent(db: DbOrTx, input: RecordEventInput): Promise<{ eventId: string; duplicate: boolean }> {
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
    .onConflictDoNothing()
    .returning({ id: connectorEvents.id });
  if (row) return { eventId: row.id, duplicate: false };
  // Keep the caller's transaction usable when a concurrent insert wins.
  const [existingAfterInsert] = await db
    .select({ id: connectorEvents.id })
    .from(connectorEvents)
    .where(and(eq(connectorEvents.connectorId, input.connectorId), eq(connectorEvents.externalEventId, input.externalEventId)))
    .limit(1);
  if (!existingAfterInsert) throw new Error("event conflict without an existing event");
  return { eventId: existingAfterInsert.id, duplicate: true };
}

export async function markEventProcessed(db: DbOrTx, eventId: string): Promise<void> {
  await db.update(connectorEvents).set({ status: "processed", processedAt: new Date() }).where(eq(connectorEvents.id, eventId));
}

export async function markEventFailed(db: DbOrTx, eventId: string, error: string): Promise<void> {
  await db.update(connectorEvents).set({ status: "failed", error, processedAt: new Date() }).where(eq(connectorEvents.id, eventId));
}

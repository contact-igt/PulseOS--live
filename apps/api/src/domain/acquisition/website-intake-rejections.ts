import type { Db } from "../../db/client.js";
import { connectorEvents } from "../../db/schema.js";

// Why a website submission was refused, as the Integration Activity log shows it. Only categories with fixed wording: nothing the
// caller sent (name, phone, email, header values, the token, a raw body) can ever reach a stored event.
//
// Bounded on purpose. Only requests for a REAL connector are recorded (an unknown id has no hospital to attribute it to), and at
// most one event per connector per category per minute is written, however many requests are refused: the unique event id
// (`reject:<category>:<minute>`) makes a repeat from another API instance a no-op as well. A flood of bad requests therefore
// cannot grow the table. These are not processing errors: they never change the connector's health. Rate-limited requests are
// answered before the connector is even looked up (to keep a flood cheap), so they are deliberately not recorded here.
export type RejectionCategory = "auth" | "origin" | "validation" | "disabled";

const TEXT: Record<RejectionCategory, string> = {
  auth: "Authentication rejected",
  origin: "Origin not allowed",
  validation: "Payload invalid",
  disabled: "Connector disabled",
};

const MAX_TRACKED = 5_000;
const lastBucket = new Map<string, number>();

export async function noteRejectedSubmission(db: Db, tenantId: string, connectorId: string, category: RejectionCategory, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / 60_000);
  const key = `${connectorId}:${category}`;
  if (lastBucket.get(key) === bucket) return;
  lastBucket.delete(key);
  lastBucket.set(key, bucket);
  if (lastBucket.size > MAX_TRACKED) {
    const oldest = lastBucket.keys().next().value;
    if (oldest !== undefined) lastBucket.delete(oldest);
  }
  try {
    await db
      .insert(connectorEvents)
      .values({ tenantId, connectorId, externalEventId: `reject:${category}:${bucket}`, direction: "inbound", status: "failed", payload: { type: "website_rejected", category }, error: TEXT[category], processedAt: new Date(now) })
      .onConflictDoNothing();
  } catch {
    // Visibility must never change the answer the website gets.
  }
}

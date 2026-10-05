import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db, queryClient } from "../db/client.js";
import { markEventFailed, markEventProcessed, recordConnectorEvent } from "../domain/connector/connector-event.service.js";

// A provider retries a delivery that failed. The retry must be processed again; only a delivery that was PROCESSED (or
// is still being worked on) is a duplicate. Otherwise one transient error loses the lead/call/message for good.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("connector event retries (integration)", () => {
  let tenantId: string;
  let connectorId: string;
  const ids: string[] = [];
  const fresh = (label: string) => {
    const id = `retry-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    return id;
  };
  const record = (externalEventId: string) => recordConnectorEvent(db, { tenantId, connectorId, externalEventId, direction: "inbound", payload: { type: "test" } });

  beforeAll(async () => {
    const [c] = await queryClient`select c.id, c.tenant_id from connectors c join tenants t on t.id = c.tenant_id where c.provider = 'website_form' and t.name = 'PulseOS Gynecology Demo' limit 1`;
    connectorId = c!.id as string;
    tenantId = c!.tenant_id as string;
  });

  afterAll(async () => {
    await queryClient`delete from connector_events where external_event_id = any(${ids})`;
    await queryClient.end();
  });

  it("the first delivery is new; the same event while it is in flight is a duplicate", async () => {
    const id = fresh("inflight");
    const first = await record(id);
    expect(first.duplicate).toBe(false);
    expect((await record(id)).duplicate).toBe(true);
  });

  it("a processed event is a duplicate forever", async () => {
    const id = fresh("done");
    const { eventId } = await record(id);
    await markEventProcessed(db, eventId);
    expect((await record(id)).duplicate).toBe(true);
  });

  it("a FAILED event is reprocessed on the provider's retry, then deduplicated once it succeeds", async () => {
    const id = fresh("failed");
    const { eventId } = await record(id);
    await markEventFailed(db, eventId, "boom");

    const retry = await record(id);
    expect(retry.duplicate).toBe(false);
    expect(retry.eventId).toBe(eventId); // the same row is reused, not a second one
    const [row] = await queryClient`select status, error from connector_events where id = ${eventId}`;
    expect(row).toMatchObject({ status: "received", error: null });

    // Two retries racing for the same failed event: exactly one wins the claim.
    await markEventFailed(db, eventId, "boom again");
    const [a, b] = await Promise.all([record(id), record(id)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);

    await markEventProcessed(db, eventId);
    expect((await record(id)).duplicate).toBe(true);
  });

  it("an event stuck in 'received' (the worker died mid-way) is reclaimed after a while, not before", async () => {
    const id = fresh("stuck");
    const { eventId } = await record(id);
    expect((await record(id)).duplicate).toBe(true); // fresh: still being worked on

    await queryClient`update connector_events set received_at = now() - interval '30 minutes' where id = ${eventId}`;
    expect((await record(id)).duplicate).toBe(false);
    expect((await record(id)).duplicate).toBe(true); // reclaimed once, then in flight again
  });
});

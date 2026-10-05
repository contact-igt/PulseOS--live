import type { WebhookEventType } from "@pulseos/types";

/**
 * Real PulseOS facts, published AFTER the change is committed, for integrations (outbound webhooks today). Payload
 * data carries identifiers and operational fields only — never free-text notes, never secrets.
 */
export interface IntegrationEvent {
  type: WebhookEventType;
  tenantId: string;
  /** Deterministic per fact (e.g. "appointment.booked:<id>"): the idempotency key for every consumer. */
  eventId: string;
  occurredAt: Date;
  data: Record<string, string | number | boolean | null>;
}

type Handler = (event: IntegrationEvent) => void | Promise<void>;
const handlers = new Set<Handler>();

export function onIntegrationEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Fire-and-forget: a failing consumer can never fail the already-committed change that produced the event. */
export function emitIntegrationEvent(event: IntegrationEvent): void {
  for (const h of handlers) {
    try {
      void Promise.resolve(h(event)).catch((err) => console.error("integration event handler failed", event.type, err));
    } catch (err) {
      console.error("integration event handler failed", event.type, err);
    }
  }
}

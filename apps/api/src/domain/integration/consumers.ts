import type { Db } from "../../db/client.js";
import { onAppointmentEvent } from "../appointment/appointment-events.js";
import { emitIntegrationEvent, onIntegrationEvent } from "./domain-events.js";
import { enqueueWebhookDeliveries } from "./outbound-webhook.service.js";

const registered = new WeakSet<Db>();

/**
 * Subscribes the integration consumers (outbound webhooks) to the domain events. Idempotent per database handle, so
 * building the app more than once (tests) never double-delivers. Appointment/surgery events arrive on their own bus and
 * are re-published here as the public, versioned event types.
 */
export function registerIntegrationConsumers(db: Db): void {
  if (registered.has(db)) return;
  registered.add(db);

  onAppointmentEvent((e) => {
    const at = new Date();
    switch (e.type) {
      case "appointment.booked":
        return emitIntegrationEvent({ type: "appointment.booked", tenantId: e.tenantId, eventId: `appointment.booked:${e.appointmentId}`, occurredAt: at, data: { appointmentId: e.appointmentId, scheduledAt: e.scheduledAt.toISOString() } });
      case "appointment.rescheduled":
        return emitIntegrationEvent({ type: "appointment.rescheduled", tenantId: e.tenantId, eventId: `appointment.rescheduled:${e.appointmentId}:${e.previousScheduledAt.getTime()}>${e.scheduledAt.getTime()}`, occurredAt: at, data: { appointmentId: e.appointmentId, previousScheduledAt: e.previousScheduledAt.toISOString(), scheduledAt: e.scheduledAt.toISOString(), hospitalAction: e.hospitalAction } });
      case "appointment.cancelled":
        return emitIntegrationEvent({ type: "appointment.cancelled", tenantId: e.tenantId, eventId: `appointment.cancelled:${e.appointmentId}`, occurredAt: at, data: { appointmentId: e.appointmentId, reasonCode: e.reasonCode, hospitalAction: e.hospitalAction } });
      case "appointment.completed":
        return emitIntegrationEvent({ type: "appointment.completed", tenantId: e.tenantId, eventId: `appointment.completed:${e.appointmentId}`, occurredAt: at, data: { appointmentId: e.appointmentId } });
      case "surgery.scheduled":
        return emitIntegrationEvent({ type: "surgery.scheduled", tenantId: e.tenantId, eventId: `surgery.scheduled:${e.treatmentId}:${e.plannedDate?.toISOString() ?? "unscheduled"}`, occurredAt: at, data: { treatmentId: e.treatmentId, plannedDate: e.plannedDate?.toISOString() ?? null } });
      default:
        return; // no_show / surgery.rescheduled / surgery.cancelled are not public webhook events
    }
  });

  onIntegrationEvent(async (event) => {
    await enqueueWebhookDeliveries(db, event);
  });
}

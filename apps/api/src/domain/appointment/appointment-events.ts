/**
 * Domain events for appointments, published AFTER the change is committed. Nothing consumes them yet: the reminder
 * engine (M7) subscribes here to cancel and rebuild reminder jobs when a visit moves or is cancelled, without the
 * appointment code knowing that reminders exist.
 */
export type AppointmentDomainEvent =
  | { type: "appointment.booked"; tenantId: string; appointmentId: string; scheduledAt: Date }
  | { type: "appointment.confirmed"; tenantId: string; appointmentId: string }
  | { type: "appointment.rescheduled"; tenantId: string; appointmentId: string; previousScheduledAt: Date; scheduledAt: Date; reasonCode: string; hospitalAction: boolean }
  | { type: "appointment.cancelled"; tenantId: string; appointmentId: string; reasonCode: string; hospitalAction: boolean }
  | { type: "appointment.no_show"; tenantId: string; appointmentId: string }
  | { type: "appointment.completed"; tenantId: string; appointmentId: string }
  | { type: "surgery.scheduled" | "surgery.rescheduled" | "surgery.cancelled"; tenantId: string; treatmentId: string; plannedDate: Date | null };

type Handler = (event: AppointmentDomainEvent) => void | Promise<void>;
const handlers = new Set<Handler>();

export function onAppointmentEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Fire-and-forget: a failing subscriber can never fail (or roll back) the booking that already succeeded. */
export function emitAppointmentEvent(event: AppointmentDomainEvent): void {
  for (const h of handlers) {
    try {
      void Promise.resolve(h(event)).catch((err) => console.error("appointment event handler failed", event.type, err));
    } catch (err) {
      console.error("appointment event handler failed", event.type, err);
    }
  }
}

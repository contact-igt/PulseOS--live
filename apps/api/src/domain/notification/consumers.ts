import type { Db } from "../../db/client.js";
import { onAppointmentEvent } from "../appointment/appointment-events.js";
import { onIntegrationEvent } from "../integration/domain-events.js";
import { cancelPendingForSubject, planForSubject } from "./notification.service.js";

const registered = new WeakSet<Db>();

/**
 * Appointment/surgery domain events → notifications. The appointment and treatment code never knows reminders exist; it
 * publishes facts after they are committed, and this keeps the tenant's reminders in step with them.
 */
export function registerNotificationConsumers(db: Db): void {
  if (registered.has(db)) return;
  registered.add(db);

  onAppointmentEvent(async (e) => {
    switch (e.type) {
      // Booked is not confirmed: the confirmation message and the reminders start only once the visit is CONFIRMED (a visit
      // that is booked already confirmed is planned right here). planForSubject itself refuses an unconfirmed visit.
      case "appointment.booked":
      case "appointment.confirmed":
        await planForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId);
        return;
      case "appointment.rescheduled":
        await cancelPendingForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId, "RESCHEDULED");
        await planForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId);
        return;
      case "appointment.cancelled":
        await cancelPendingForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId, "APPOINTMENT_CANCELLED");
        return;
      case "appointment.no_show":
        await cancelPendingForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId, "NO_SHOW");
        return;
      case "appointment.completed":
        await cancelPendingForSubject(db, e.tenantId, "APPOINTMENT", e.appointmentId, "APPOINTMENT_COMPLETED");
        return;
      case "surgery.scheduled":
        await planForSubject(db, e.tenantId, "SURGERY", e.treatmentId);
        return;
      case "surgery.rescheduled":
        await cancelPendingForSubject(db, e.tenantId, "SURGERY", e.treatmentId, "RESCHEDULED");
        await planForSubject(db, e.tenantId, "SURGERY", e.treatmentId);
        return;
      case "surgery.cancelled":
        await cancelPendingForSubject(db, e.tenantId, "SURGERY", e.treatmentId, "APPOINTMENT_CANCELLED");
        return;
    }
  });

  onIntegrationEvent(async (e) => {
    if (e.type === "surgery.completed" && typeof e.data.treatmentId === "string") await cancelPendingForSubject(db, e.tenantId, "SURGERY", e.data.treatmentId, "APPOINTMENT_COMPLETED");
  });
}

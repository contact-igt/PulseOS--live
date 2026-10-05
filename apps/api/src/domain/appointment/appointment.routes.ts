import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { hasPermission } from "@pulseos/types";
import { appointments } from "../../db/schema.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { diffDays, isRealDate } from "../../lib/hospital-time.js";
import {
  MAX_APPOINTMENT_RANGE_DAYS,
  applyAppointmentAction,
  checkSlot,
  completeAppointment,
  createAppointment,
  getCalendarContext,
  getFrontDeskDashboard,
  listAppointments,
  rescheduleAppointment,
} from "./appointment.service.js";

const createAppointmentBody = z.object({
  patientId: z.string().uuid(),
  journeyId: z.string().uuid(),
  branchId: z.string().uuid(),
  doctorId: z.string().uuid(),
  scheduledAt: z.string(),
  reason: z.string().optional(),
});

const localDay = z.string().refine(isRealDate);

// List filters. Dates are local days in the tenant's timezone; a malformed one
// is a 400, never a 500 from the database driver.
const listAppointmentsQuery = z
  .object({
    branchId: z.string().uuid().optional(),
    doctorId: z.string().uuid().optional(),
    journeyId: z.string().uuid().optional(),
    status: z.enum(["requested", "scheduled", "confirmed", "checked_in", "waiting", "with_doctor", "completed", "no_show", "cancelled"]).optional(),
    date: localDay.optional(),
    from: localDay.optional(),
    to: localDay.optional(),
    search: z.string().max(200).optional(),
  })
  .refine((q) => !q.from === !q.to, "from and to go together")
  .refine((q) => !q.from || !q.to || (diffDays(q.from, q.to) >= 0 && diffDays(q.from, q.to) < MAX_APPOINTMENT_RANGE_DAYS), "invalid range");

const reasonCode = z.enum(["patient_requested", "doctor_unavailable", "hospital_reschedule", "hospital_cancelled", "timing_conflict", "unable_to_reach", "patient_no_show", "other"]);
const actionBody = z.object({
  queue: z.boolean().optional(),
  action: z.enum(["confirm", "check_in", "mark_waiting", "send_to_doctor", "mark_no_show", "cancel"]),
  reasonCode: reasonCode.optional(),
  note: z.string().max(500).optional(),
});
const rescheduleBody = z.object({ scheduledAt: z.string(), reasonCode, note: z.string().max(500).optional() });
const completeBody = z
  .object({
    next: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("follow_up"), followUp: z.object({ followUpTypeId: z.string().uuid(), dueAt: z.string(), assignedTo: z.string().uuid().nullable().optional(), priority: z.enum(["normal", "high"]).optional(), note: z.string().max(500).optional() }) }),
        z.object({ kind: z.literal("surgery"), surgery: z.object({ treatmentDefinitionId: z.string().uuid(), scheduledAt: z.string(), resourceId: z.string().uuid(), branchId: z.string().uuid(), note: z.string().max(500).optional() }) }),
      ])
      .optional(),
    note: z.string().max(500).optional(),
  })
  .optional();

const REASON_STATUS: Record<string, number> = {
  appointment_not_found: 404,
  appointment_closed: 409,
  not_with_doctor: 409,
  invalid_transition: 409,
  conflict: 409,
  reason_required: 422,
  reason_invalid: 422,
  scheduled_in_past: 422,
  appointment_time_in_past: 422,
  outside_clinic_hours: 422,
  resource_unavailable: 409,
  // completion's embedded follow-up / surgery
  type_invalid: 422,
  due_in_past: 422,
  note_required: 422,
  assignee_invalid: 422,
  invalid_due_at: 422,
  journey_not_found: 422,
  treatment_invalid: 422,
  resource_invalid: 422,
  branch_invalid: 422,
  surgery_already_scheduled: 409,
  forbidden: 403,
};

// create: bad input 400, the time rules 422, a taken slot 409, an unknown patient/journey/branch/doctor 404.
const CREATE_STATUS: Record<string, number> = { invalid_request: 400, appointment_time_in_past: 422, outside_clinic_hours: 422, resource_unavailable: 409 };

const uuid = z.string().uuid();

export async function appointmentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("VIEW_APPOINTMENTS"));

  app.get("/appointments", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const parsed = listAppointmentsQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    return listAppointments(app.db, tenantId, parsed.data);
  });

  // Hospital timezone + its local "today", so every appointment view (list,
  // calendar, doctor schedule, front desk) draws day boundaries the same way.
  app.get("/appointments/calendar-context", async (request) => {
    return getCalendarContext(app.db, request.sessionUser!.tenantId);
  });

  // Is this doctor free then? An advisory answer for the booking form (yes/no only — never who holds the slot).
  app.get("/appointments/slot-check", async (request, reply) => {
    const parsed = z.object({ doctorId: z.string().uuid(), scheduledAt: z.string().min(1).max(40), excludeId: z.string().uuid().optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await checkSlot(app.db, request.sessionUser!.tenantId, parsed.data.doctorId, parsed.data.scheduledAt, request.sessionUser!.timezone, parsed.data.excludeId);
    if (!result.ok) return reply.status(result.reason === "invalid_request" ? 400 : 404).send({ error: result.reason });
    return { available: result.available, inPast: result.inPast, outsideHours: result.outsideHours };
  });

  app.get("/front-desk", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const parsed = z.object({ branchId: z.string().uuid().optional(), date: localDay.optional() }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    return getFrontDeskDashboard(app.db, tenantId, parsed.data.branchId, new Date(), parsed.data.date);
  });

  // Finishing a consultation: Front Desk, Coordinator, Admin and Super Admin (MANAGE_APPOINTMENTS) for any visit, and a Doctor for
  // the visit that is with them and nobody else's. Everything else about a visit (check-in, waiting, sending to the doctor)
  // stays with MANAGE_APPOINTMENTS.
  app.patch("/appointments/:id/complete", async (request, reply) => {
    const user = request.sessionUser!;
    const { id } = request.params as { id: string };
    if (!uuid.safeParse(id).success) return reply.status(404).send({ error: "appointment_not_found" });
    const canManage = hasPermission(user.role, "MANAGE_APPOINTMENTS");
    if (!canManage && !hasPermission(user.role, "COMPLETE_CONSULTATION")) return reply.status(403).send({ error: "forbidden", requiredPermission: "MANAGE_APPOINTMENTS" });
    if (!canManage) {
      const [own] = await app.db.select({ doctorUserId: appointments.doctorUserId }).from(appointments).where(and(eq(appointments.tenantId, user.tenantId), eq(appointments.id, id))).limit(1);
      if (!own) return reply.status(404).send({ error: "appointment_not_found" });
      if (own.doctorUserId !== user.id) return reply.status(403).send({ error: "forbidden" });
    }
    const parsed = completeBody.safeParse(request.body ?? undefined);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const result = await completeAppointment(app.db, user.tenantId, id, { id: user.id, canManageTreatment: hasPermission(user.role, "MANAGE_TREATMENT") }, parsed.data ?? {}, user.timezone);
    if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
    return result;
  });

  await app.register(async (manageApp) => {
    manageApp.addHook("preHandler", requirePermission("MANAGE_APPOINTMENTS"));

    manageApp.post("/appointments", async (request, reply) => {
      const tenantId = request.sessionUser!.tenantId;
      const actorId = request.sessionUser!.id;
      const parsed = createAppointmentBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

      const result = await createAppointment(app.db, tenantId, actorId, parsed.data, request.sessionUser!.timezone);
      if (!result.ok) return reply.status(CREATE_STATUS[result.reason] ?? 404).send({ error: result.reason });
      return reply.status(201).send(result.appointment);
    });

    manageApp.patch("/appointments/:id/action", async (request, reply) => {
      const tenantId = request.sessionUser!.tenantId;
      const actorId = request.sessionUser!.id;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success) return reply.status(404).send({ error: "appointment_not_found" });
      const parsed = actionBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
      const result = await applyAppointmentAction(app.db, tenantId, id, actorId, parsed.data, request.sessionUser!.timezone);
      if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
      return result;
    });

    manageApp.patch("/appointments/:id/reschedule", async (request, reply) => {
      const tenantId = request.sessionUser!.tenantId;
      const actorId = request.sessionUser!.id;
      const { id } = request.params as { id: string };
      if (!uuid.safeParse(id).success) return reply.status(404).send({ error: "appointment_not_found" });
      const parsed = rescheduleBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
      const result = await rescheduleAppointment(app.db, tenantId, id, actorId, parsed.data, request.sessionUser!.timezone);
      if (!result.ok) return reply.status(REASON_STATUS[result.reason] ?? 400).send({ error: result.reason });
      return result;
    });
  });
}

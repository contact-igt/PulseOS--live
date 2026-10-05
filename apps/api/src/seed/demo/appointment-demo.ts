import { and, asc, eq, gt, notInArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { appointments, journeys, scheduleResources, treatmentDefinitions, treatmentOpportunities } from "../../db/schema.js";
import { applyAppointmentAction, createAppointment, rescheduleAppointment } from "../../domain/appointment/appointment.service.js";
import { createResource } from "../../domain/resource/resource.service.js";
import { scheduleSurgery } from "../../domain/treatment/treatment.service.js";
import { todaySlot } from "./demo-clock.js";
import { daysFromNow } from "./shared.js";

const TZ = "Asia/Kolkata";
const days = (d: number, h: number) => daysFromNow(d, h, 0);

interface Actors {
  admin: { id: string };
  coordinator: { id: string };
  frontDesk: { id: string };
  doctorId: string;
  branchId: string;
}

/**
 * The appointment-to-surgery loop needs every state visible in the demo: a patient still to check in, a no-show with
 * its Appointment Risk task, a hospital reschedule with its risk, a scheduled Cataract surgery (with a visiting
 * surgeon who has no login) and a scheduled laser procedure. Queue states (waiting, with doctor, completed) come from
 * the base seed with real timestamps; everything here goes through the same services Staff use.
 */
export async function seedAppointmentDemo(tenantId: string, a: Actors) {
  const [linked] = await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, tenantId), eq(scheduleResources.linkedUserId, a.doctorId))).limit(1);
  if (!linked) throw new Error("seed: the demo doctor has no scheduling resource");
  const visiting = await createResource(db, tenantId, { name: "Dr Anand Kulkarni (Visiting Surgeon)" });
  if (!visiting.ok) throw new Error(`seed: visiting surgeon failed (${visiting.reason})`);

  // Active journeys with no appointment today and no procedure yet, oldest first — each story gets its own.
  const used = new Set((await db.select({ j: appointments.journeyId }).from(appointments).where(eq(appointments.tenantId, tenantId))).map((r) => r.j));
  const withTreatment = new Set((await db.select({ j: treatmentOpportunities.journeyId }).from(treatmentOpportunities).where(eq(treatmentOpportunities.tenantId, tenantId))).map((r) => r.j));
  const free = (
    await db
      .select({ id: journeys.id, patientId: journeys.patientId, specialtyKey: journeys.specialtyKey })
      .from(journeys)
      .where(and(eq(journeys.tenantId, tenantId), notInArray(journeys.stage, ["completed", "lost", "scheduled"])))
      .orderBy(asc(journeys.createdAt))
  ).filter((j) => !withTreatment.has(j.id));
  const take = (pred: (j: (typeof free)[number]) => boolean, label: string) => {
    const j = free.find((x) => pred(x) && !claimed.has(x.id));
    if (!j) throw new Error(`seed: no free journey for ${label}`);
    claimed.add(j.id);
    return j;
  };
  const claimed = new Set<string>();

  // These stories book through the real service, which (rightly) refuses a doctor's occupied minute. Demo slots come
  // from the demo clock and can land on a minute another seeded visit already holds, so move by 15 minutes until free.
  const heldMinutes = async () =>
    new Set((await db.select({ at: appointments.scheduledAt }).from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.resourceId, linked.id), notInArray(appointments.status, ["cancelled", "no_show"])))).map((r) => Math.floor(r.at.getTime() / 60_000)));
  const freeSlot = async (wanted: Date, stepMinutes: number) => {
    const held = await heldMinutes();
    let at = wanted;
    while (held.has(Math.floor(at.getTime() / 60_000))) at = new Date(at.getTime() + stepMinutes * 60_000);
    return at;
  };

  // 1 — Booked today, patient not yet arrived.
  const booked = take((j) => !used.has(j.id), "today's booked visit");
  // The demo clock keeps this slot "upcoming" at any hour (capped at 19:00); when the seed runs after that, the real
  // clock would call it past, so the booking is made as of an hour before the slot (a normal earlier booking).
  const bookedSlot = await freeSlot(todaySlot("scheduled", 4), 15);
  const b = await createAppointment(db, tenantId, a.frontDesk.id, { patientId: booked.patientId, journeyId: booked.id, branchId: a.branchId, doctorId: linked.id, scheduledAt: bookedSlot.toISOString(), reason: "Consultation" }, TZ, new Date(Math.min(Date.now(), bookedSlot.getTime() - 3_600_000)));
  if (!b.ok) throw new Error(`seed: booked visit failed (${b.reason})`);

  // 2 — A no-show today: marked through the lifecycle, so its Appointment Risk task exists exactly once.
  const missed = take((j) => !used.has(j.id), "the no-show");
  const noShowSlot = await freeSlot(todaySlot("no_show", 3), -15); // earlier today: the visit was booked before it and the patient did not come
  const m = await createAppointment(db, tenantId, a.frontDesk.id, { patientId: missed.patientId, journeyId: missed.id, branchId: a.branchId, doctorId: linked.id, scheduledAt: noShowSlot.toISOString(), reason: "Cataract consultation" }, TZ, new Date(noShowSlot.getTime() - 3_600_000)); // booked earlier, so the backdated visit is a legitimate booking
  if (!m.ok) throw new Error(`seed: no-show visit failed (${m.reason})`);
  const ns = await applyAppointmentAction(db, tenantId, m.appointment.id, a.frontDesk.id, { action: "mark_no_show", note: "Phone was switched off" }, TZ);
  if (!ns.ok) throw new Error(`seed: no-show failed (${ns.reason})`);

  // 3 — A hospital reschedule (doctor away): an upcoming confirmed visit moves a day, and the patient must be told.
  const [upcoming] = await db
    .select({ id: appointments.id, at: appointments.scheduledAt })
    .from(appointments)
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.status, "confirmed"), gt(appointments.scheduledAt, days(1, 12))))
    .orderBy(asc(appointments.scheduledAt))
    .limit(1);
  if (upcoming) {
    const r = await rescheduleAppointment(db, tenantId, upcoming.id, a.coordinator.id, { scheduledAt: (await freeSlot(new Date(upcoming.at.getTime() + 24 * 3_600_000), 15)).toISOString(), reasonCode: "doctor_unavailable", note: "Doctor is at a conference" }, TZ);
    if (!r.ok) throw new Error(`seed: hospital reschedule failed (${r.reason})`);
  }

  // 4 + 5 — Scheduled procedures, through the treatment lifecycle: Cataract with the visiting surgeon, a laser with our doctor.
  const procedure = async (key: string) => (await db.select({ id: treatmentDefinitions.id }).from(treatmentDefinitions).where(and(eq(treatmentDefinitions.tenantId, tenantId), eq(treatmentDefinitions.key, key))).limit(1))[0]!.id;
  const cat = take((j) => j.specialtyKey === "CATARACT", "the cataract surgery");
  const s1 = await scheduleSurgery(db, tenantId, a.coordinator.id, cat.id, { treatmentDefinitionId: await procedure("CATARACT_SURGERY"), scheduledAt: days(6, 9).toISOString(), resourceId: visiting.resource.id, branchId: a.branchId, note: "Right eye · bring previous reports" }, TZ);
  if (!s1.ok) throw new Error(`seed: cataract surgery failed (${s1.reason})`);
  const lvc = take((j) => j.specialtyKey === "LASER_VISION_CORRECTION", "the laser procedure");
  const s2 = await scheduleSurgery(db, tenantId, a.coordinator.id, lvc.id, { treatmentDefinitionId: await procedure("LASIK"), scheduledAt: days(9, 11).toISOString(), resourceId: linked.id, branchId: a.branchId }, TZ);
  if (!s2.ok) throw new Error(`seed: laser procedure failed (${s2.reason})`);
}

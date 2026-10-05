import { and, asc, eq, notInArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { followUpTypes, journeys } from "../../db/schema.js";
import { createAppointment } from "../../domain/appointment/appointment.service.js";
import { createLead } from "../../domain/lead/lead.service.js";
import { createFollowUp, createTask } from "../../domain/task/task.service.js";
import { ensureFollowUpTypes } from "../../domain/task/followup-type.service.js";

const TZ = "Asia/Kolkata";
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

interface Actors {
  admin: { id: string; name: string };
  coordinator: { id: string; name: string };
  frontDesk: { id: string; name: string };
  doctorId: string;
  branchId: string;
}

/**
 * The Journey workspace needs every state to be visible in the demo: an overdue Callback, an Appointment Follow-up due
 * today, an Appointment Risk, an upcoming Surgery Follow-up, a Journey with no follow-up at all, and a Journey with an
 * appointment booked. All of it goes through the same services staff use.
 */
export async function seedFollowUpDemo(tenantId: string, a: Actors) {
  await ensureFollowUpTypes(db, tenantId);
  const typeId = async (key: string) => (await db.select({ id: followUpTypes.id }).from(followUpTypes).where(and(eq(followUpTypes.tenantId, tenantId), eq(followUpTypes.key, key))))[0]!.id;

  // Active journeys, oldest first; each story gets its own journey.
  const active = await db
    .select({ id: journeys.id, patientId: journeys.patientId, owner: journeys.ownerUserId })
    .from(journeys)
    .where(and(eq(journeys.tenantId, tenantId), notInArray(journeys.stage, ["completed", "lost"])))
    .orderBy(asc(journeys.createdAt));
  const pick = (i: number) => {
    const j = active[i];
    if (!j) throw new Error(`seed: no active journey #${i} for follow-up demo data`);
    return j;
  };
  const OVERDUE = pick(3);
  const TODAY = pick(5);
  const RISK = pick(7);
  const SURGERY = pick(9);
  const BOOK = pick(11);

  // 1 — an overdue Callback (the Task engine accepts work that is already late).
  const overdue = await createTask(db, tenantId, a.coordinator.id, { patientId: OVERDUE.patientId, journeyId: OVERDUE.id, type: "CALLBACK", assignedTo: a.coordinator.id, dueAt: hours(-26).toISOString(), notes: "Patient asked for a call back about the consultation slot" }, TZ);
  if (!overdue.ok) throw new Error(`seed: overdue callback failed (${overdue.reason})`);

  // 2 — an Appointment Follow-up due later today (hospital day).
  const endOfDay = new Date(Date.parse(`${new Date().toLocaleDateString("en-CA", { timeZone: TZ })}T00:00:00+05:30`) + 86_400_000);
  const laterToday = new Date(Date.now() + (endOfDay.getTime() - Date.now()) / 2);
  const today = await createFollowUp(db, tenantId, { id: a.frontDesk.id }, TODAY.id, { followUpTypeId: await typeId("appointment_followup"), dueAt: laterToday.toISOString(), assignedTo: a.frontDesk.id, note: "Interested — will decide on a slot after speaking to family" }, TZ);
  if (!today.ok) throw new Error(`seed: appointment follow-up failed (${today.reason})`);

  // 3 — an Appointment Risk (any reason: here, the doctor is away).
  const risk = await createFollowUp(db, tenantId, { id: a.coordinator.id }, RISK.id, { followUpTypeId: await typeId("appointment_risk"), dueAt: hours(20).toISOString(), assignedTo: a.coordinator.id, note: "Doctor unavailable on the booked day — offer the next free slot" }, TZ);
  if (!risk.ok) throw new Error(`seed: appointment risk failed (${risk.reason})`);

  // 4 — an upcoming Surgery Follow-up (surgery scheduling itself is a later module).
  const surgery = await createFollowUp(db, tenantId, { id: a.coordinator.id }, SURGERY.id, { followUpTypeId: await typeId("surgery_followup"), dueAt: hours(72).toISOString(), assignedTo: a.coordinator.id, note: "Confirm the surgery decision with the patient" }, TZ);
  if (!surgery.ok) throw new Error(`seed: surgery follow-up failed (${surgery.reason})`);

  // 5 — a Journey with NO follow-up scheduled: a fresh walk-in enquiry.
  const lead = await createLead(db, tenantId, a.frontDesk.id, { phone: "+91 98450 61122", name: "Kavitha Reddy", specialtyKey: "GENERAL_EYE_CONSULTATION", branchId: a.branchId, journeyType: "General Eye Consultation", sourceKey: "walk_in", channel: "WALK_IN", customFieldValues: {} }, "FRONT_DESK", TZ);
  if ("validationError" in lead || "stepError" in lead) throw new Error("seed: walk-in lead failed");

  // 6 — a Journey with an appointment booked tomorrow morning.
  const tomorrow = new Date(endOfDay.getTime() + 10.5 * 3_600_000); // 10:30 hospital time tomorrow
  const booked = await createAppointment(db, tenantId, a.frontDesk.id, { patientId: BOOK.patientId, journeyId: BOOK.id, branchId: a.branchId, doctorId: a.doctorId, scheduledAt: tomorrow.toISOString(), reason: "Consultation" }, TZ);
  if (!booked.ok) throw new Error(`seed: appointment failed (${booked.reason})`);
}

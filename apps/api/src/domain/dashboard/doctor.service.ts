import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import type { Db } from "../../db/client.js";
import { inLocalRange, localToday, tenantTimezone, tzLiteral } from "../../lib/hospital-time.js";
import { appointments, consultationOutcomes, journeys, patients, treatmentOpportunities } from "../../db/schema.js";
import type { DoctorDashboard, DoctorRecentPatient, DoctorTodayItem } from "@pulseos/types";

export async function getDoctorDashboard(db: Db, tenantId: string, doctorUserId: string, now: Date = new Date(), date?: string): Promise<DoctorDashboard> {
  // "Today" is the hospital's local day (tenants.timezone), not the server clock's.
  const timezone = await tenantTimezone(db, tenantId);
  const todayKey = await localToday(db, timezone, now);
  // The schedule is for `date` (a hospital day) - today unless the doctor looked at another day. "Recent patients" always
  // means before today, whichever day is on screen.
  const dayKey = date ?? todayKey;
  const beforeToday = sql`${appointments.scheduledAt} < (${todayKey}::date)::timestamp at time zone ${tzLiteral(timezone)}`;

  const rows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      scheduledAt: appointments.scheduledAt,
      patientName: patientNameSql,
      journeyType: journeys.journeyType,
      specialtyKey: journeys.specialtyKey,
      journeyId: appointments.journeyId,
      patientId: appointments.patientId,
      reason: appointments.reason,
      hasOutcome: consultationOutcomes.id,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(journeys, eq(appointments.journeyId, journeys.id))
    .leftJoin(consultationOutcomes, eq(consultationOutcomes.appointmentId, appointments.id))
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        eq(appointments.doctorUserId, doctorUserId),
        inLocalRange(appointments.scheduledAt, timezone, dayKey, dayKey),
      ),
    )
    .orderBy(appointments.scheduledAt);

  const toItem = (r: { id: string; patientName: string; scheduledAt: Date; status: DoctorTodayItem["status"]; patientId: string; journeyId: string; journeyType: string; specialtyKey: string | null }): DoctorTodayItem => ({
    appointmentId: r.id,
    patientName: r.patientName,
    time: r.scheduledAt.toISOString(),
    status: r.status,
    patientId: r.patientId,
    journeyId: r.journeyId,
    journeyType: r.journeyType,
    specialtyKey: r.specialtyKey,
  });

  const today: DoctorTodayItem[] = rows.map(toItem);

  const waitingNow = rows.filter((r) => r.status === "checked_in" || r.status === "waiting").length;
  const withMeCount = rows.filter((r) => r.status === "with_doctor").length;
  const checkedInCount = rows.filter((r) => r.status === "checked_in" || r.status === "waiting" || r.status === "with_doctor" || r.status === "completed").length;
  const completedCount = rows.filter((r) => r.status === "completed").length;
  const eligibleForCompletion = rows.filter((r) => r.status !== "cancelled").length;
  const completionPct = eligibleForCompletion > 0 ? Math.round((completedCount / eligibleForCompletion) * 100) : 0;

  const nextRow = rows.find((r) => r.status === "scheduled" || r.status === "confirmed" || r.status === "checked_in" || r.status === "waiting");
  const nextPatient = nextRow
    ? {
        appointmentId: nextRow.id,
        patientName: nextRow.patientName,
        journeyType: nextRow.journeyType,
        appointmentTime: nextRow.scheduledAt.toISOString(),
        reason: nextRow.reason,
        patientId: nextRow.patientId,
        journeyId: nextRow.journeyId,
      }
    : null;

  const awaitingOutcome: DoctorTodayItem[] = rows
    .filter((r) => r.status === "completed" && !r.hasOutcome)
    .map(toItem);

  // Treatment Follow-ups: today's journeys with a treatment opportunity still
  // awaiting the patient's decision or acceptance — real domain state, not a flag.
  const todayJourneyIds = rows.map((r) => r.journeyId).filter((id): id is string => id !== null);
  const pendingTreatmentJourneyIds = new Set<string>();
  if (todayJourneyIds.length > 0) {
    const openTreatments = await db
      .select({ journeyId: treatmentOpportunities.journeyId })
      .from(treatmentOpportunities)
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), inArray(treatmentOpportunities.journeyId, todayJourneyIds), inArray(treatmentOpportunities.status, ["ADVISED", "DECISION_PENDING"])));
    for (const t of openTreatments) pendingTreatmentJourneyIds.add(t.journeyId);
  }
  const treatmentFollowUps: DoctorTodayItem[] = rows
    .filter((r) => r.journeyId && pendingTreatmentJourneyIds.has(r.journeyId))
    .map(toItem);

  const pastRows = await db
    .select({
      id: appointments.id,
      status: appointments.status,
      scheduledAt: appointments.scheduledAt,
      patientName: patientNameSql,
      journeyType: journeys.journeyType,
      specialtyKey: journeys.specialtyKey,
      journeyId: appointments.journeyId,
      patientId: appointments.patientId,
      hasOutcome: consultationOutcomes.id,
      outcome: consultationOutcomes.outcome,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .innerJoin(journeys, eq(appointments.journeyId, journeys.id))
    .leftJoin(consultationOutcomes, eq(consultationOutcomes.appointmentId, appointments.id))
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.doctorUserId, doctorUserId), eq(appointments.status, "completed"), beforeToday))
    .orderBy(desc(appointments.scheduledAt))
    .limit(10);

  // Post-care / Reviews: seen, no treatment required — routine follow-up candidates.
  const postCare: DoctorTodayItem[] = pastRows
    .filter((r) => r.outcome === "NO_TREATMENT_REQUIRED")
    .map(toItem);

  const recentPatients: DoctorRecentPatient[] = pastRows.map((r) => ({
    appointmentId: r.id,
    patientName: r.patientName,
    patientId: r.patientId,
    journeyType: r.journeyType,
    time: r.scheduledAt.toISOString(),
  }));

  return {
    date: dayKey,
    todayCount: rows.length,
    checkedInCount,
    waitingNow,
    withMeCount,
    completionPct,
    nextPatient,
    today,
    awaitingOutcome,
    treatmentFollowUps,
    postCare,
    recentPatients,
  };
}

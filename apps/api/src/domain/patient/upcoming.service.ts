import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, journeys, patients, scheduleResources, tasks, treatmentOpportunities, users } from "../../db/schema.js";
import { tenantTimezone, tzLiteral } from "../../lib/hospital-time.js";
import type { PatientUpcoming, PatientUpcomingItem } from "@pulseos/types";

/** Appointment states that still lie ahead of the patient (not completed / no-show / cancelled). */
const OPEN_APPOINTMENT = ["requested", "scheduled", "confirmed", "checked_in", "waiting", "with_doctor"] as const;

export interface UpcomingScope {
  /** VIEW_APPOINTMENTS */
  appointments: boolean;
  /** VIEW_TREATMENT */
  treatments: boolean;
  /** VIEW_TASKS; `onlyAssignedTo` narrows to one user exactly like GET /tasks does for a non-MANAGE_TASKS caller. */
  tasks: boolean;
  onlyAssignedTo?: string;
}

/**
 * Patient 360 "Upcoming" — derived ONLY from existing rows for one patient:
 *  - appointments still open, scheduled from the start of the hospital's today onward;
 *  - open (pending / in-progress) tasks, overdue ones flagged rather than hidden;
 *  - treatments with status SCHEDULED and a planned date from hospital-today onward.
 * Every item carries its journey so a multi-journey patient's list stays unambiguous.
 * Returns null when the patient is not in the caller's tenant.
 */
export async function getPatientUpcoming(db: Db, tenantId: string, patientId: string, scope: UpcomingScope, now = new Date()): Promise<PatientUpcoming | null> {
  const [patient] = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId))).limit(1);
  if (!patient) return null;

  const timezone = await tenantTimezone(db, tenantId);
  const tz = tzLiteral(timezone);
  // Start of the hospital's local today, as an instant.
  const todayStart = sql`(date_trunc('day', ${now.toISOString()}::timestamptz at time zone ${tz}) at time zone ${tz})`;
  const items: PatientUpcomingItem[] = [];

  if (scope.appointments) {
    const rows = await db
      .select({ id: appointments.id, at: appointments.scheduledAt, reason: appointments.reason, status: appointments.status, journeyId: appointments.journeyId, journeyType: journeys.journeyType, doctorName: scheduleResources.name })
      .from(appointments)
      .innerJoin(journeys, eq(appointments.journeyId, journeys.id))
      .leftJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.patientId, patientId), inArray(appointments.status, [...OPEN_APPOINTMENT]), gte(appointments.scheduledAt, todayStart)));
    for (const r of rows) {
      items.push({ kind: "appointment", id: r.id, at: r.at.toISOString(), label: r.reason, status: r.status, overdue: false, journeyId: r.journeyId, journeyType: r.journeyType, personName: r.doctorName });
    }
  }

  if (scope.tasks) {
    const rows = await db
      .select({ id: tasks.id, at: tasks.dueAt, type: tasks.type, status: tasks.status, journeyId: tasks.journeyId, journeyType: journeys.journeyType, assignee: users.name })
      .from(tasks)
      .leftJoin(journeys, eq(tasks.journeyId, journeys.id))
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.patientId, patientId),
          or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")),
          scope.onlyAssignedTo ? eq(tasks.assignedTo, scope.onlyAssignedTo) : undefined,
        ),
      );
    for (const r of rows) {
      items.push({ kind: "task", id: r.id, at: r.at.toISOString(), label: r.type, status: r.status, overdue: r.at.getTime() < now.getTime(), journeyId: r.journeyId, journeyType: r.journeyType, personName: r.assignee });
    }
  }

  if (scope.treatments) {
    const rows = await db
      .select({ id: treatmentOpportunities.id, at: treatmentOpportunities.plannedDate, label: treatmentOpportunities.treatmentLabel, status: treatmentOpportunities.status, journeyId: treatmentOpportunities.journeyId, journeyType: journeys.journeyType, owner: sql<string | null>`coalesce(${scheduleResources.name}, ${users.name})` })
      .from(treatmentOpportunities)
      .innerJoin(journeys, eq(treatmentOpportunities.journeyId, journeys.id))
      .leftJoin(users, eq(treatmentOpportunities.ownerUserId, users.id))
      .leftJoin(scheduleResources, eq(treatmentOpportunities.scheduledResourceId, scheduleResources.id))
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.patientId, patientId), eq(treatmentOpportunities.status, "SCHEDULED"), gte(treatmentOpportunities.plannedDate, todayStart)));
    for (const r of rows) {
      if (!r.at) continue;
      items.push({ kind: "treatment", id: r.id, at: r.at.toISOString(), label: r.label, status: r.status, overdue: false, journeyId: r.journeyId, journeyType: r.journeyType, personName: r.owner });
    }
  }

  items.sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { timezone, items };
}

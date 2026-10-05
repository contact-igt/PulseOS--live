import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, branches, crmOutcomes, departments, journeys, leadSources, patients, scheduleResources, tasks, treatmentOpportunities, users } from "../../db/schema.js";
import { inLocalRange, localDay, tzLiteral } from "../../lib/hospital-time.js";
import type {
  OperationsDay,
  OperationsFunnelStage,
  OperationsOwnerRow,
  OperationsPipelineStage,
  OperationsReport,
  OperationsServiceRow,
  OperationsSourceRow,
  ReportFilterOptions,
  ReportPeriod,
  ReportQuery,
  SourceChannel,
} from "@pulseos/types";
import { periodDays, resolveReportPeriod } from "./report-period.js";

// One scoped fact set per question, all bounded by the period, aggregated here so every number on the page — and in
// the Excel workbook — derives from the same rows. Days are computed in SQL in the hospital's timezone.

const ATTENDED = ["checked_in", "waiting", "with_doctor", "completed"] as const;
const OPEN_TASK = ["pending", "in_progress"] as const;
const PROCEDURE_PLANNED = ["SCHEDULED", "COMPLETED"] as const;

const FUNNEL: { key: OperationsFunnelStage["key"]; label: string }[] = [
  { key: "enquiry", label: "Enquiries" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Appointment booked" },
  { key: "attended", label: "Attended" },
  { key: "procedure", label: "Procedure scheduled" },
  { key: "converted", label: "Converted" },
];

const PIPELINE: { key: OperationsPipelineStage["key"]; label: string }[] = [
  { key: "enquiry", label: "Enquiries" },
  { key: "booked", label: "Appointment booked" },
  { key: "checked_in", label: "Checked in" },
  { key: "consulted", label: "Consultation completed" },
  { key: "procedure", label: "Surgery scheduled" },
];

const BUCKET_LABEL: Record<SourceChannel, string> = {
  meta: "Meta", google: "Google", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walk_in: "Walk-in", referral: "Referral", organic: "Organic", other: "Other",
};

export const UNKNOWN_PATIENT = "Unknown patient";

export interface EnquiryFact {
  id: string;
  patientId: string;
  patientName: string | null;
  phone: string;
  day: string;
  createdAt: Date;
  stage: string;
  service: string;
  sourceId: string | null;
  sourceLabel: string | null;
  bucket: SourceChannel;
  ownerUserId: string | null;
  ownerName: string | null;
  branchName: string | null;
  contacted: boolean;
  lastOutcomeKey: string | null;
  lastOutcomeLabel: string | null;
  booked: boolean;
  attended: boolean;
  /** A consultation was completed (a visit reached Completed). */
  consulted: boolean;
  procedure: boolean;
  converted: boolean;
}

export interface AppointmentFact {
  id: string;
  patientName: string | null;
  phone: string;
  scheduledAt: Date;
  scheduledDay: string;
  createdDay: string;
  status: string;
  doctorName: string | null;
  branchName: string | null;
  service: string;
  sourceLabel: string | null;
  bucket: SourceChannel;
  reasonCode: string | null;
  scheduledInPeriod: boolean;
  bookedInPeriod: boolean;
}

export interface FollowUpFact {
  id: string;
  patientName: string | null;
  phone: string;
  journeyId: string | null;
  service: string | null;
  type: string;
  typeLabel: string | null;
  priority: string;
  status: string;
  dueAt: Date;
  dueDay: string;
  completedAt: Date | null;
  completedDay: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  notes: string | null;
  dueInPeriod: boolean;
  overdue: boolean;
  completedInPeriod: boolean;
}

export interface ProcedureFact {
  id: string;
  status: string;
  label: string;
  patientName: string | null;
  phone: string;
  service: string;
  plannedDate: Date | null;
  completedAt: Date | null;
  paymentAt: Date | null;
  doctorName: string | null;
  branchName: string | null;
  estimatedValue: number;
  plannedInPeriod: boolean;
  completedInPeriod: boolean;
}

export interface ReportFacts {
  period: ReportPeriod;
  enquiries: EnquiryFact[];
  appointments: AppointmentFact[];
  followUps: FollowUpFact[];
  procedures: ProcedureFact[];
  /** Completed procedures (all time, same filters) whose completion time was never recorded — never dated by payment. */
  completedUndated: number;
}

/** Journey-level scope (journeys + patients must be in FROM). Branch is the patient's branch. */
function journeyScope(tenantId: string, q: ReportQuery, opts: { owner: boolean }): (SQL | undefined)[] {
  return [
    eq(journeys.tenantId, tenantId),
    q.branchId ? eq(patients.branchId, q.branchId) : undefined,
    q.service ? eq(journeys.journeyType, q.service) : undefined,
    q.departmentId ? eq(journeys.departmentId, q.departmentId) : undefined,
    q.sourceId ? eq(journeys.sourceId, q.sourceId) : undefined,
    opts.owner && q.ownerId ? eq(journeys.ownerUserId, q.ownerId) : undefined,
  ];
}

const exists = (body: SQL) => sql<boolean>`exists (${body})`;

export async function loadReportFacts(db: Db, tenantId: string, q: ReportQuery, now: Date = new Date()): Promise<ReportFacts> {
  const period = await resolveReportPeriod(db, tenantId, q, now);
  const { timezone, from, to } = period;
  const tz = tzLiteral(timezone);
  const periodEnd = sql`((${to}::date + 1))::timestamp at time zone ${tz}`;

  const enquiryRows = await db
    .select({
      id: journeys.id,
      patientId: patients.id,
      patientName: patients.name,
      phone: patients.phone,
      day: localDay(journeys.createdAt, timezone),
      createdAt: journeys.createdAt,
      stage: journeys.stage,
      service: journeys.journeyType,
      sourceId: journeys.sourceId,
      sourceLabel: leadSources.label,
      bucket: journeys.source,
      ownerUserId: journeys.ownerUserId,
      ownerName: sql<string | null>`(select u.name from users u where u.id = ${journeys.ownerUserId} and u.tenant_id = ${tenantId})`,
      branchName: branches.name,
      contacted: sql<boolean>`(${journeys.contactedAt} is not null or ${journeys.stage} <> 'enquiry')`,
      lastOutcomeKey: crmOutcomes.key,
      lastOutcomeLabel: crmOutcomes.label,
      booked: exists(sql`select 1 from appointments a where a.journey_id = ${journeys.id} and a.tenant_id = ${tenantId}`),
      attended: exists(sql`select 1 from appointments a where a.journey_id = ${journeys.id} and a.tenant_id = ${tenantId} and a.status in ('checked_in','waiting','with_doctor','completed')`),
      consulted: exists(sql`select 1 from appointments a where a.journey_id = ${journeys.id} and a.tenant_id = ${tenantId} and a.status = 'completed'`),
      procedure: exists(sql`select 1 from treatment_opportunities t where t.journey_id = ${journeys.id} and t.tenant_id = ${tenantId} and t.status in ('SCHEDULED','COMPLETED')`),
      converted: exists(sql`select 1 from treatment_opportunities t where t.journey_id = ${journeys.id} and t.tenant_id = ${tenantId} and t.status = 'COMPLETED'`),
    })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .leftJoin(leadSources, and(eq(leadSources.id, journeys.sourceId), eq(leadSources.tenantId, tenantId)))
    .leftJoin(crmOutcomes, and(eq(crmOutcomes.id, journeys.lastOutcomeId), eq(crmOutcomes.tenantId, tenantId)))
    .leftJoin(branches, and(eq(branches.id, patients.branchId), eq(branches.tenantId, tenantId)))
    .where(and(...journeyScope(tenantId, q, { owner: true }), inLocalRange(journeys.createdAt, timezone, from, to)))
    .orderBy(journeys.createdAt);

  // Appointments scheduled in the period, or booked (created) in it. Branch / doctor filters are the visit's own.
  const apptRows = await db
    .select({
      id: appointments.id,
      patientName: patients.name,
      phone: patients.phone,
      scheduledAt: appointments.scheduledAt,
      scheduledDay: localDay(appointments.scheduledAt, timezone),
      createdDay: localDay(appointments.createdAt, timezone),
      status: appointments.status,
      doctorName: scheduleResources.name,
      branchName: branches.name,
      service: journeys.journeyType,
      sourceLabel: leadSources.label,
      bucket: journeys.source,
      reasonCode: appointments.statusReasonCode,
      scheduledInPeriod: sql<boolean>`(${inLocalRange(appointments.scheduledAt, timezone, from, to)})`,
      bookedInPeriod: sql<boolean>`(${inLocalRange(appointments.createdAt, timezone, from, to)})`,
    })
    .from(appointments)
    .innerJoin(journeys, and(eq(journeys.id, appointments.journeyId), eq(journeys.tenantId, tenantId)))
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .leftJoin(scheduleResources, and(eq(scheduleResources.id, appointments.resourceId), eq(scheduleResources.tenantId, tenantId)))
    .leftJoin(branches, and(eq(branches.id, appointments.branchId), eq(branches.tenantId, tenantId)))
    .leftJoin(leadSources, and(eq(leadSources.id, journeys.sourceId), eq(leadSources.tenantId, tenantId)))
    .where(
      and(
        eq(appointments.tenantId, tenantId),
        q.branchId ? eq(appointments.branchId, q.branchId) : undefined,
        q.service ? eq(journeys.journeyType, q.service) : undefined,
        q.departmentId ? eq(journeys.departmentId, q.departmentId) : undefined,
        q.sourceId ? eq(journeys.sourceId, q.sourceId) : undefined,
        q.ownerId ? eq(journeys.ownerUserId, q.ownerId) : undefined,
        q.doctorId ? eq(appointments.resourceId, q.doctorId) : undefined,
        or(inLocalRange(appointments.scheduledAt, timezone, from, to), inLocalRange(appointments.createdAt, timezone, from, to)),
      ),
    )
    .orderBy(appointments.scheduledAt);

  // Follow-ups: open ones due before the period ends (due in it, or overdue now) and ones completed in it.
  // A task without a Journey has no service/source, so it drops out once one of those filters is set.
  const journeyFilter = Boolean(q.service || q.sourceId || q.departmentId);
  const taskRows = await db
    .select({
      id: tasks.id,
      patientName: patients.name,
      phone: patients.phone,
      journeyId: tasks.journeyId,
      service: journeys.journeyType,
      type: tasks.type,
      typeLabel: sql<string | null>`(select f.label from followup_types f where f.id = ${tasks.followUpTypeId} and f.tenant_id = ${tenantId})`,
      priority: tasks.priority,
      status: tasks.status,
      dueAt: tasks.dueAt,
      dueDay: localDay(tasks.dueAt, timezone),
      completedAt: tasks.completedAt,
      completedDay: sql<string | null>`case when ${tasks.completedAt} is null then null else ${localDay(tasks.completedAt, timezone)} end`,
      assignedTo: tasks.assignedTo,
      assigneeName: users.name,
      notes: tasks.notes,
      dueInPeriod: sql<boolean>`(${tasks.status} in ('pending','in_progress') and ${inLocalRange(tasks.dueAt, timezone, from, to)})`,
      overdue: sql<boolean>`(${tasks.status} in ('pending','in_progress') and ${tasks.dueAt} < ${now.toISOString()}::timestamptz)`,
      completedInPeriod: sql<boolean>`(${tasks.status} = 'completed' and ${tasks.completedAt} is not null and ${inLocalRange(tasks.completedAt, timezone, from, to)})`,
    })
    .from(tasks)
    .innerJoin(patients, eq(patients.id, tasks.patientId))
    .leftJoin(journeys, and(eq(journeys.id, tasks.journeyId), eq(journeys.tenantId, tenantId)))
    .leftJoin(users, and(eq(users.id, tasks.assignedTo), eq(users.tenantId, tenantId)))
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        q.branchId ? eq(patients.branchId, q.branchId) : undefined,
        journeyFilter ? isNotNull(journeys.id) : undefined,
        q.service ? eq(journeys.journeyType, q.service) : undefined,
        q.departmentId ? eq(journeys.departmentId, q.departmentId) : undefined,
        q.sourceId ? eq(journeys.sourceId, q.sourceId) : undefined,
        q.ownerId ? eq(tasks.assignedTo, q.ownerId) : undefined,
        or(
          and(inArray(tasks.status, [...OPEN_TASK]), sql`${tasks.dueAt} < ${periodEnd}`),
          and(eq(tasks.status, "completed"), isNotNull(tasks.completedAt), inLocalRange(tasks.completedAt, timezone, from, to)),
        ),
      ),
    )
    .orderBy(tasks.dueAt);

  // Three different dates, three different questions — never substituted for one another:
  //   planned_date  = Scheduled for   (the procedure calendar; "Procedures planned")
  //   completed_at  = Completed on    ("Procedures completed", stamped by the treatment transition)
  //   revenue_events.occurred_at = Payment date (revenue; shown for reference, never used to date a completion)
  // A COMPLETED procedure with no completed_at (completed before it was recorded) is not guessed from a payment: it is
  // excluded from date-specific completed counts and surfaced as "completed, date not recorded".
  // Filters every procedure row honours (service / source / owner are the journey's). Branch and doctor are recorded only
  // on a SCHEDULED procedure, so they narrow the dated rows but cannot narrow "date not recorded" ones — which would
  // otherwise vanish the moment someone picks a branch, hiding the very warning they exist to raise.
  const procedureCommon = [
    eq(treatmentOpportunities.tenantId, tenantId),
    q.service ? eq(journeys.journeyType, q.service) : undefined,
    q.departmentId ? eq(journeys.departmentId, q.departmentId) : undefined,
    q.sourceId ? eq(journeys.sourceId, q.sourceId) : undefined,
    q.ownerId ? eq(journeys.ownerUserId, q.ownerId) : undefined,
  ];
  const procedurePlace = [
    q.branchId ? eq(treatmentOpportunities.scheduledBranchId, q.branchId) : undefined,
    q.doctorId ? eq(treatmentOpportunities.scheduledResourceId, q.doctorId) : undefined,
  ];
  const procedureRows = await db
    .select({
      id: treatmentOpportunities.id,
      status: treatmentOpportunities.status,
      label: treatmentOpportunities.treatmentLabel,
      patientName: patients.name,
      phone: patients.phone,
      service: journeys.journeyType,
      plannedDate: treatmentOpportunities.plannedDate,
      completedAt: treatmentOpportunities.completedAt,
      paymentAt: sql<Date | null>`(select min(r.occurred_at) from revenue_events r where r.treatment_opportunity_id = ${treatmentOpportunities.id} and r.tenant_id = ${tenantId})`,
      doctorName: scheduleResources.name,
      branchName: branches.name,
      estimatedValue: treatmentOpportunities.estimatedValue,
      plannedInPeriod: sql<boolean>`(${treatmentOpportunities.plannedDate} is not null and ${inLocalRange(treatmentOpportunities.plannedDate, timezone, from, to)})`,
      completedInPeriod: sql<boolean>`(${treatmentOpportunities.status} = 'COMPLETED' and ${treatmentOpportunities.completedAt} is not null and ${inLocalRange(treatmentOpportunities.completedAt, timezone, from, to)})`,
    })
    .from(treatmentOpportunities)
    .innerJoin(journeys, and(eq(journeys.id, treatmentOpportunities.journeyId), eq(journeys.tenantId, tenantId)))
    .innerJoin(patients, eq(patients.id, treatmentOpportunities.patientId))
    .leftJoin(scheduleResources, and(eq(scheduleResources.id, treatmentOpportunities.scheduledResourceId), eq(scheduleResources.tenantId, tenantId)))
    .leftJoin(branches, and(eq(branches.id, treatmentOpportunities.scheduledBranchId), eq(branches.tenantId, tenantId)))
    .where(
      and(
        ...procedureCommon,
        inArray(treatmentOpportunities.status, [...PROCEDURE_PLANNED]),
        or(
          and(...procedurePlace, isNotNull(treatmentOpportunities.plannedDate), inLocalRange(treatmentOpportunities.plannedDate, timezone, from, to)),
          and(...procedurePlace, eq(treatmentOpportunities.status, "COMPLETED"), isNotNull(treatmentOpportunities.completedAt), inLocalRange(treatmentOpportunities.completedAt, timezone, from, to)),
          // Completed with no recorded time: carried along (flagged "date not recorded" in the workbook) so they can be found; counted nowhere by date.
          and(eq(treatmentOpportunities.status, "COMPLETED"), sql`${treatmentOpportunities.completedAt} is null`),
        ),
      ),
    )
    .orderBy(treatmentOpportunities.plannedDate);

  // How many completed procedures (whole history, same non-date filters) have no completion time recorded.
  const [{ undated }] = await db
    .select({ undated: sql<number>`count(*)::int` })
    .from(treatmentOpportunities)
    .innerJoin(journeys, and(eq(journeys.id, treatmentOpportunities.journeyId), eq(journeys.tenantId, tenantId)))
    .where(and(...procedureCommon, eq(treatmentOpportunities.status, "COMPLETED"), sql`${treatmentOpportunities.completedAt} is null`));

  return {
    period,
    enquiries: enquiryRows as EnquiryFact[],
    appointments: apptRows as AppointmentFact[],
    // Overdue-but-out-of-period rows are kept for the "Overdue now" count only.
    followUps: taskRows as FollowUpFact[],
    procedures: procedureRows as ProcedureFact[],
    completedUndated: undated,
  };
}

const rate = (n: number, d: number) => (d > 0 ? n / d : null);

/** How far an enquiry got. Cumulative: a later stage implies the earlier ones, so the funnel never widens. */
function reached(e: EnquiryFact): number {
  if (e.converted) return 5;
  if (e.procedure) return 4;
  if (e.attended) return 3;
  if (e.booked) return 2;
  if (e.contacted) return 1;
  return 0;
}

export function buildOperationsReport(f: ReportFacts): OperationsReport {
  const { period, enquiries, appointments: appts, followUps, procedures } = f;
  const scheduled = appts.filter((a) => a.scheduledInPeriod);
  const isAttended = (s: string) => (ATTENDED as readonly string[]).includes(s);
  const converted = enquiries.filter((e) => e.converted).length;

  const kpis = {
    newEnquiries: enquiries.length,
    uncontacted: enquiries.filter((e) => !e.contacted).length,
    noResponse: enquiries.filter((e) => e.lastOutcomeKey === "no_answer" && reached(e) <= 1 && e.stage !== "lost").length,
    followUpsDue: followUps.filter((t) => t.dueInPeriod).length,
    followUpsOverdue: followUps.filter((t) => t.overdue).length,
    followUpsCompleted: followUps.filter((t) => t.completedInPeriod).length,
    appointmentsBooked: appts.filter((a) => a.bookedInPeriod).length,
    appointmentsScheduled: scheduled.length,
    appointmentsAttended: scheduled.filter((a) => isAttended(a.status)).length,
    appointmentsNoShow: scheduled.filter((a) => a.status === "no_show").length,
    appointmentsCancelled: scheduled.filter((a) => a.status === "cancelled").length,
    consultationsCompleted: scheduled.filter((a) => a.status === "completed").length,
    proceduresScheduled: procedures.filter((p) => p.plannedInPeriod).length,
    proceduresCompleted: procedures.filter((p) => p.completedInPeriod).length,
    proceduresCompletedUndated: f.completedUndated,
    converted,
    conversionRate: rate(converted, enquiries.length),
  };

  const daily: OperationsDay[] = periodDays(period).map((day) => {
    const s = scheduled.filter((a) => a.scheduledDay === day);
    return {
      day,
      enquiries: enquiries.filter((e) => e.day === day).length,
      appointmentsScheduled: s.length,
      attended: s.filter((a) => isAttended(a.status)).length,
      consultationsCompleted: s.filter((a) => a.status === "completed").length,
      noShow: s.filter((a) => a.status === "no_show").length,
      cancelled: s.filter((a) => a.status === "cancelled").length,
      followUpsDue: followUps.filter((t) => t.dueInPeriod && t.dueDay === day).length,
      followUpsCompleted: followUps.filter((t) => t.completedInPeriod && t.completedDay === day).length,
    };
  });

  const funnel = FUNNEL.map((s, i) => ({ ...s, count: enquiries.filter((e) => reached(e) >= i).length }));
  // The analytics pipeline: cumulative like the funnel — a later step implies the earlier ones, so it never widens.
  const pipelineLevel = (e: EnquiryFact) => (e.procedure || e.converted ? 4 : e.consulted ? 3 : e.attended ? 2 : e.booked ? 1 : 0);
  const pipeline: OperationsPipelineStage[] = PIPELINE.map((s, i) => ({ ...s, count: enquiries.filter((e) => pipelineLevel(e) >= i).length }));

  const sourceMap = new Map<string, OperationsSourceRow>();
  for (const e of enquiries) {
    const key = e.sourceId ?? `bucket:${e.bucket}`;
    const row = sourceMap.get(key) ?? { sourceId: e.sourceId, label: e.sourceLabel ?? BUCKET_LABEL[e.bucket], bucket: e.bucket, enquiries: 0, contacted: 0, booked: 0, attended: 0, converted: 0, conversionRate: null };
    const r = reached(e);
    row.enquiries += 1;
    if (r >= 1) row.contacted += 1;
    if (r >= 2) row.booked += 1;
    if (r >= 3) row.attended += 1;
    if (r >= 5) row.converted += 1;
    sourceMap.set(key, row);
  }
  const bySource = [...sourceMap.values()]
    .map((r) => ({ ...r, conversionRate: rate(r.converted, r.enquiries) }))
    .sort((a, b) => b.enquiries - a.enquiries || a.label.localeCompare(b.label));

  const ownerMap = new Map<string, OperationsOwnerRow>();
  const ownerRow = (id: string | null, name: string | null) => {
    const key = id ?? "unassigned";
    const row = ownerMap.get(key) ?? { userId: id, name: id ? (name ?? "Former staff") : "Unassigned", enquiries: 0, uncontacted: 0, followUpsDue: 0, followUpsOverdue: 0, followUpsCompleted: 0 };
    ownerMap.set(key, row);
    return row;
  };
  for (const e of enquiries) {
    const row = ownerRow(e.ownerUserId, e.ownerName);
    row.enquiries += 1;
    if (!e.contacted) row.uncontacted += 1;
  }
  for (const t of followUps) {
    if (!t.dueInPeriod && !t.overdue && !t.completedInPeriod) continue;
    const row = ownerRow(t.assignedTo, t.assigneeName);
    if (t.dueInPeriod) row.followUpsDue += 1;
    if (t.overdue) row.followUpsOverdue += 1;
    if (t.completedInPeriod) row.followUpsCompleted += 1;
  }
  const byOwner = [...ownerMap.values()].sort((a, b) => (a.userId === null ? 1 : 0) - (b.userId === null ? 1 : 0) || b.followUpsOverdue - a.followUpsOverdue || b.enquiries - a.enquiries || a.name.localeCompare(b.name));

  const serviceMap = new Map<string, OperationsServiceRow>();
  for (const e of enquiries) {
    const row = serviceMap.get(e.service) ?? { service: e.service, enquiries: 0, booked: 0, attended: 0, converted: 0 };
    const r = reached(e);
    row.enquiries += 1;
    if (r >= 2) row.booked += 1;
    if (r >= 3) row.attended += 1;
    if (r >= 5) row.converted += 1;
    serviceMap.set(e.service, row);
  }
  const byService = [...serviceMap.values()].sort((a, b) => b.enquiries - a.enquiries || a.service.localeCompare(b.service));

  return { period, kpis, daily, funnel, pipeline, bySource, byOwner, byService };
}

export async function getOperationsReport(db: Db, tenantId: string, q: ReportQuery, now?: Date): Promise<OperationsReport> {
  return buildOperationsReport(await loadReportFacts(db, tenantId, q, now));
}

export async function getReportFilterOptions(db: Db, tenantId: string): Promise<ReportFilterOptions> {
  const [branchRows, departmentRows, serviceRows, sourceRows, ownerRows, doctorRows] = await Promise.all([
    db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, tenantId)).orderBy(branches.name),
    db.select({ id: departments.id, name: departments.displayName }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.archived, false))).orderBy(departments.displayName),
    db.selectDistinct({ service: journeys.journeyType }).from(journeys).where(eq(journeys.tenantId, tenantId)).orderBy(journeys.journeyType),
    db.select({ id: leadSources.id, label: leadSources.label, archived: leadSources.archived }).from(leadSources).where(eq(leadSources.tenantId, tenantId)).orderBy(leadSources.sortOrder, leadSources.label),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), inArray(users.role, ["HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"])))
      .orderBy(users.name),
    db.select({ id: scheduleResources.id, name: scheduleResources.name }).from(scheduleResources).where(eq(scheduleResources.tenantId, tenantId)).orderBy(scheduleResources.name),
  ]);
  return { branches: branchRows, departments: departmentRows, services: serviceRows.map((r) => r.service), sources: sourceRows, owners: ownerRows, doctors: doctorRows };
}

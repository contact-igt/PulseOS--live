import { and, asc, eq, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, calls, consultationOutcomes, customFieldDefinitions, customFieldValues, journeys, leadSources, patients, tasks, tenants, treatmentOpportunities, users } from "../../db/schema.js";
import { displayAge } from "../../lib/age.js";
import { dayKeyIn } from "../../lib/hospital-time.js";
import { buildAgeDimension, buildFieldDimension } from "./demographics.js";
import { inLocalRange } from "../../lib/hospital-time.js";
import { addDays } from "../../lib/hospital-time.js";
import type { DashboardPeriod, DemographicDimension, PerformanceDashboard, PerformanceStaffRow, SourceChannel } from "@pulseos/types";
import { buildAlert, buildBreakdown, buildFunnel, buildInsights, furthestStep, type PerfJourneyFact } from "./performance.js";

export interface PerformanceFilters {
  branchId?: string;
  journeyType?: string;
  period?: DashboardPeriod;
}

const SOURCE_FALLBACK: Record<SourceChannel, string> = { meta: "Meta", google: "Google", website: "Website", whatsapp: "WhatsApp", phone: "Phone", walk_in: "Walk-in", referral: "Referral", organic: "Organic", other: "Other" };
const ARRIVED = ["checked_in", "waiting", "with_doctor", "completed"] as const;
const OPEN_TASK = ["pending", "in_progress"] as const;
const UNDECIDED_AFTER_DAYS = 7;

/** The journeys opened inside `range` (hospital days), narrowed to the branch / service, each with the facts that place it on the funnel. */
async function loadFacts(db: Db, tenantId: string, filters: PerformanceFilters, range: { from: string; to: string; timezone: string } | null): Promise<PerfJourneyFact[]> {
  const cohort: (SQL | undefined)[] = [
    eq(journeys.tenantId, tenantId),
    filters.branchId ? eq(patients.branchId, filters.branchId) : undefined,
    filters.journeyType ? eq(journeys.journeyType, filters.journeyType) : undefined,
    range ? inLocalRange(journeys.createdAt, range.timezone, range.from, range.to) : undefined,
  ];

  const rows = await db
    .select({
      id: journeys.id,
      stage: journeys.stage,
      contactedAt: journeys.contactedAt,
      source: journeys.source,
      sourceKey: leadSources.key,
      sourceLabel: leadSources.label,
      journeyType: journeys.journeyType,
      ownerId: journeys.ownerUserId,
    })
    .from(journeys)
    .innerJoin(patients, eq(patients.id, journeys.patientId))
    .leftJoin(leadSources, eq(leadSources.id, journeys.sourceId))
    .where(and(...cohort));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // One read per kind of fact, never one per journey. (inArray on a few thousand ids is fine at this scale.)
  const [apptRows, treatmentRows] = await Promise.all([
    db.select({ journeyId: appointments.journeyId, status: appointments.status, checkedInAt: appointments.checkedInAt }).from(appointments).where(and(eq(appointments.tenantId, tenantId), inArray(appointments.journeyId, ids))),
    db.select({ journeyId: treatmentOpportunities.journeyId, status: treatmentOpportunities.status }).from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), inArray(treatmentOpportunities.journeyId, ids))),
  ]);

  const flags = new Map<string, { booked: boolean; attended: boolean; consulted: boolean; noShow: boolean; advised: boolean; scheduled: boolean; done: boolean }>();
  const flag = (id: string) => {
    let f = flags.get(id);
    if (!f) flags.set(id, (f = { booked: false, attended: false, consulted: false, noShow: false, advised: false, scheduled: false, done: false }));
    return f;
  };
  for (const a of apptRows) {
    const f = flag(a.journeyId);
    if (a.status !== "cancelled") f.booked = true;
    if ((ARRIVED as readonly string[]).includes(a.status) || a.checkedInAt) f.attended = true;
    if (a.status === "completed") f.consulted = true;
    if (a.status === "no_show") f.noShow = true;
  }
  for (const t of treatmentRows) {
    const f = flag(t.journeyId);
    f.advised = true;
    if (t.status === "SCHEDULED" || t.status === "COMPLETED") f.scheduled = true;
    if (t.status === "COMPLETED") f.done = true;
  }

  return rows.map((r) => ({
    id: r.id,
    sourceKey: r.sourceKey ?? r.source,
    sourceLabel: r.sourceLabel ?? SOURCE_FALLBACK[r.source] ?? r.source,
    journeyType: r.journeyType,
    ownerId: r.ownerId,
    contacted: r.contactedAt !== null,
    lost: r.stage === "lost",
    booked: false, attended: false, consulted: false, noShow: false, advised: false, scheduled: false, done: false,
    ...flags.get(r.id),
  }));
}

/**
 * Who is enquiring, for the journeys on the funnel: the age group (derived from date of birth, else the reported age) and every field
 * the hospital marked filterable - choice fields, and free text that repeats (an area). Real answers only; a dimension with none is
 * simply absent. Fields only some roles may see (clinical-only) never appear in this report.
 */
async function loadDemographics(db: Db, tenantId: string, journeyIds: string[], now: Date): Promise<DemographicDimension[]> {
  if (journeyIds.length === 0) return [];
  const [tenant] = await db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const today = dayKeyIn(now, tenant?.timezone ?? "Asia/Kolkata");
  const people = await db.select({ dateOfBirth: patients.dateOfBirth, reportedAge: patients.reportedAge }).from(journeys).innerJoin(patients, eq(patients.id, journeys.patientId)).where(and(eq(journeys.tenantId, tenantId), inArray(journeys.id, journeyIds)));
  const out: DemographicDimension[] = [];
  const age = buildAgeDimension(people.map((p) => displayAge(p.dateOfBirth, p.reportedAge, today)));
  if (age) out.push(age);

  const defs = await db
    .select({ id: customFieldDefinitions.id, key: customFieldDefinitions.key, label: customFieldDefinitions.label, fieldType: customFieldDefinitions.fieldType })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.tenantId, tenantId), eq(customFieldDefinitions.archived, false), eq(customFieldDefinitions.filterable, true), eq(customFieldDefinitions.visibleTo, "everyone"), inArray(customFieldDefinitions.fieldType, ["SELECT", "TEXT"])))
    .orderBy(asc(customFieldDefinitions.sortOrder));
  if (defs.length === 0) return out;
  const values = await db
    .select({ defId: customFieldValues.fieldDefinitionId, value: customFieldValues.value })
    .from(customFieldValues)
    .where(and(eq(customFieldValues.tenantId, tenantId), inArray(customFieldValues.journeyId, journeyIds), inArray(customFieldValues.fieldDefinitionId, defs.map((d) => d.id))));
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.key)) continue; // a service-specific copy and the shared one are the same question
    seen.add(d.key);
    const sameKey = new Set(defs.filter((x) => x.key === d.key).map((x) => x.id));
    const dim = buildFieldDimension(d, values.filter((v) => sameKey.has(v.defId) && typeof v.value === "string").map((v) => v.value as string));
    if (dim) out.push(dim);
  }
  return out;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

/**
 * The owner's Performance view: the funnel from this period's enquiries, rule-based findings, the same steps by original source
 * and by service, and what each team member did. Only real rows are counted; there is no revenue in it, so it exists for every
 * hospital. `now` is injectable for tests.
 */
export async function getPerformanceDashboard(db: Db, tenantId: string, filters: PerformanceFilters, now: Date = new Date()): Promise<PerformanceDashboard> {
  const period = filters.period ?? null;
  const facts = await loadFacts(db, tenantId, filters, period);
  const funnel = buildFunnel(facts);
  const step = (key: string) => funnel.find((s) => s.key === key)!.count;

  // Live findings (right now) and period findings share one scope: the branch and service chosen on the page.
  const scopeJourney = (idColumn: unknown): SQL | undefined => {
    if (!filters.branchId && !filters.journeyType) return undefined;
    const branch = filters.branchId ? sql` and p.branch_id = ${filters.branchId}` : sql``;
    const service = filters.journeyType ? sql` and j.journey_type = ${filters.journeyType}` : sql``;
    return sql`exists (select 1 from journeys j join patients p on p.id = j.patient_id where j.id = ${idColumn}${branch}${service})`;
  };
  const apptInPeriod = period ? inLocalRange(appointments.scheduledAt, period.timezone, period.from, period.to) : undefined;

  const [overdue, noOutcomeRows, undecided] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.status, [...OPEN_TASK]), lt(tasks.dueAt, now), scopeJourney(tasks.journeyId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(appointments)
      .leftJoin(consultationOutcomes, eq(consultationOutcomes.appointmentId, appointments.id))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.status, "completed"), sql`${consultationOutcomes.id} is null`, apptInPeriod, scopeJourney(appointments.journeyId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(treatmentOpportunities)
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), inArray(treatmentOpportunities.status, ["ADVISED", "DECISION_PENDING"]), lt(treatmentOpportunities.createdAt, new Date(now.getTime() - UNDECIDED_AFTER_DAYS * 86_400_000)), scopeJourney(treatmentOpportunities.journeyId))),
  ]);

  const insights = buildInsights({
    uncontacted: facts.filter((f) => !f.contacted && !f.lost && !f.booked && !f.attended).length,
    overdueFollowUps: overdue[0]?.n ?? 0,
    noShows: facts.filter((f) => f.noShow).length,
    noOutcome: noOutcomeRows[0]?.n ?? 0,
    undecided: undecided[0]?.n ?? 0,
    lost: facts.filter((f) => f.lost).length,
  });

  // The alert compares with the period just before, of the same length.
  let alert: PerformanceDashboard["alert"] = null;
  if (period) {
    const prev = await loadFacts(db, tenantId, filters, { from: addDays(period.from, -period.days), to: addDays(period.from, -1), timezone: period.timezone });
    const snap = (fs: PerfJourneyFact[]) => ({ enquiries: fs.length, contacted: fs.filter((f) => f.contacted || furthestStep(f) >= 1).length, booked: fs.filter((f) => furthestStep(f) >= 1).length, noShows: fs.filter((f) => f.noShow).length });
    alert = buildAlert(snap(facts), snap(prev), period.days);
  }

  return {
    period,
    funnel,
    kpis: {
      enquiries: step("enquiries"),
      booked: step("booked"),
      attended: step("attended"),
      consulted: step("consulted"),
      noShows: facts.filter((f) => f.noShow).length,
      advised: step("advised"),
      scheduled: step("scheduled"),
      done: step("done"),
      attendanceRate: pct(step("attended"), step("booked")),
      consultationCompletionRate: pct(step("consulted"), step("attended")),
      conversionRate: pct(step("done"), step("enquiries")),
    },
    insights,
    demographics: await loadDemographics(db, tenantId, facts.map((f) => f.id), now),
    alert,
    sources: buildBreakdown(facts, (f) => ({ key: f.sourceKey ?? "unknown", label: f.sourceLabel })),
    services: buildBreakdown(facts, (f) => ({ key: f.journeyType, label: f.journeyType })),
    staff: await loadStaff(db, tenantId, facts, period, now),
  };
}

const ALWAYS_LISTED = ["HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR"];

async function loadStaff(db: Db, tenantId: string, facts: PerfJourneyFact[], period: DashboardPeriod | null, now: Date): Promise<PerformanceStaffRow[]> {
  const people = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.tenantId, tenantId));
  const callWindow = period ? inLocalRange(calls.startedAt, period.timezone, period.from, period.to) : undefined;
  const doneWindow = period ? inLocalRange(tasks.completedAt, period.timezone, period.from, period.to) : undefined;
  const [callRows, doneRows, overdueRows] = await Promise.all([
    db.select({ id: calls.loggedByUserId, n: sql<number>`count(*)::int` }).from(calls).where(and(eq(calls.tenantId, tenantId), isNotNull(calls.loggedByUserId), callWindow)).groupBy(calls.loggedByUserId),
    db.select({ id: tasks.completedBy, n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "completed"), isNotNull(tasks.completedBy), doneWindow)).groupBy(tasks.completedBy),
    db.select({ id: tasks.assignedTo, n: sql<number>`count(*)::int` }).from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.status, [...OPEN_TASK]), isNotNull(tasks.assignedTo), lt(tasks.dueAt, now))).groupBy(tasks.assignedTo),
  ]);
  const of = (rows: { id: string | null; n: number }[]) => new Map(rows.map((r) => [r.id, r.n]));
  const callsBy = of(callRows);
  const doneBy = of(doneRows);
  const overdueBy = of(overdueRows);

  const rows = people.map((p): PerformanceStaffRow => {
    const mine = facts.filter((f) => f.ownerId === p.id);
    return {
      userId: p.id,
      name: p.name,
      role: p.role,
      owned: mine.length,
      contacted: mine.filter((f) => f.contacted || furthestStep(f) >= 1).length,
      booked: mine.filter((f) => furthestStep(f) >= 1).length,
      callsLogged: callsBy.get(p.id) ?? 0,
      followUpsDone: doneBy.get(p.id) ?? 0,
      overdueNow: overdueBy.get(p.id) ?? 0,
    };
  });
  return rows
    .filter((r) => ALWAYS_LISTED.includes(r.role) || r.owned + r.callsLogged + r.followUpsDone + r.overdueNow > 0)
    .sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name));
}

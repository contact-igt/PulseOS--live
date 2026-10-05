import { loadOperationalStatuses } from "./operational-status.service.js";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  appointments,
  branches,
  campaignTouchpoints,
  crmOutcomes,
  departments,
  journeys,
  leadSources,
  marketingCampaigns,
  patients,
  revenueEvents,
  scheduleResources,
  tasks,
  timelineEvents,
  treatmentOpportunities,
  users,
} from "../../db/schema.js";
import { getCallStats } from "../call/call.service.js";
import { allocatedAcquisitionCost } from "../marketing/formulas.js";
import { displayAge } from "../../lib/age.js";
import { dayKeyIn } from "../../lib/hospital-time.js";
import { hasPermission } from "@pulseos/types";
import type {
  BulkAssignJourneyOwnerResult,
  JourneyDetailVm,
  JourneyListRow,
  JourneysSummary,
  Role,
  SpendAtRiskCategoryKey,
  TreatmentRow,
} from "@pulseos/types";
import { getSpendAtRisk, SPEND_AT_RISK_CATEGORIES } from "../dashboard/dashboard.service.js";
import { listAppointments } from "../appointment/appointment.service.js";
import { deriveNextAction, getNextActionForJourney, listTasks } from "../task/task.service.js";
import { getPatientTimeline } from "../timeline/timeline.service.js";
import { loadJourneyFieldValues } from "../crm/crm-field.service.js";

/**
 * Server-side `owner` list filter shared by GET /journeys and GET /leads.
 * "mine" is resolved from the SESSION user here, never from the client;
 * anything else must be a user-id uuid (or the literal "unassigned").
 */
export type OwnerFilter = { kind: "user"; userId: string } | { kind: "unassigned" };

export function parseOwnerFilter(raw: string | undefined, sessionUserId: string): OwnerFilter | undefined | "invalid" {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "mine") return { kind: "user", userId: sessionUserId };
  if (raw === "unassigned") return { kind: "unassigned" };
  return z.string().uuid().safeParse(raw).success ? { kind: "user", userId: raw } : "invalid";
}

export interface JourneyFilters {
  source?: string;
  campaignId?: string;
  branchId?: string;
  stage?: string;
  ownerId?: string;
  owner?: OwnerFilter;
  doctorId?: string;
  atRisk?: SpendAtRiskCategoryKey;
}

export async function listJourneys(db: Db, tenantId: string, filters: JourneyFilters): Promise<JourneyListRow[]> {
  const rows = await db
    .select({
      id: journeys.id,
      patientId: journeys.patientId,
      patientName: patientNameSql,
      journeyType: journeys.journeyType,
      source: journeys.source,
      stage: journeys.stage,
      branchName: branches.name,
      ownerName: users.name,
      createdAt: journeys.createdAt,
    })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .leftJoin(branches, eq(patients.branchId, branches.id))
    .leftJoin(users, eq(journeys.ownerUserId, users.id))
    .where(
      and(
        eq(journeys.tenantId, tenantId),
        filters.source ? eq(journeys.source, filters.source as (typeof journeys.source.enumValues)[number]) : undefined,
        filters.stage ? eq(journeys.stage, filters.stage as (typeof journeys.stage.enumValues)[number]) : undefined,
        filters.ownerId ? eq(journeys.ownerUserId, filters.ownerId) : undefined,
        filters.owner?.kind === "user" ? eq(journeys.ownerUserId, filters.owner.userId) : undefined,
        filters.owner?.kind === "unassigned" ? isNull(journeys.ownerUserId) : undefined,
        filters.branchId ? eq(patients.branchId, filters.branchId) : undefined,
      ),
    );

  const touchpointRows = await db
    .select({ journeyId: campaignTouchpoints.journeyId, campaignId: campaignTouchpoints.campaignId })
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.tenantId, tenantId), eq(campaignTouchpoints.touchType, "first_touch")));
  const campaignByJourney = new Map(touchpointRows.map((t) => [t.journeyId, t.campaignId]));

  const campaigns = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));

  const enquiryCounts = await db
    .select({ campaignId: campaignTouchpoints.campaignId, journeyId: campaignTouchpoints.journeyId })
    .from(campaignTouchpoints)
    .where(eq(campaignTouchpoints.tenantId, tenantId));
  const enquiryCountByCampaign = new Map<string, number>();
  for (const e of enquiryCounts) {
    if (!e.campaignId) continue;
    enquiryCountByCampaign.set(e.campaignId, (enquiryCountByCampaign.get(e.campaignId) ?? 0) + 1);
  }

  const doctorRows = await db
    .select({ journeyId: appointments.journeyId, doctorId: appointments.resourceId, doctorUserId: appointments.doctorUserId, doctorName: scheduleResources.name, scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .leftJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
    .where(eq(appointments.tenantId, tenantId));
  const doctorByJourney = new Map<string, string | null>();
  const doctorIdByJourney = new Map<string, { resourceId: string | null; userId: string | null }>();
  const latestApptByJourney = new Map<string, Date>();
  for (const d of doctorRows) {
    const existing = latestApptByJourney.get(d.journeyId);
    if (!existing || d.scheduledAt > existing) {
      latestApptByJourney.set(d.journeyId, d.scheduledAt);
      doctorByJourney.set(d.journeyId, d.doctorName);
      doctorIdByJourney.set(d.journeyId, { resourceId: d.doctorId, userId: d.doctorUserId });
    }
  }

  const taskRows = await db
    .select({ journeyId: tasks.journeyId, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "pending")));
  const nextActionByJourney = new Map<string, Date>();
  for (const t of taskRows) {
    if (!t.journeyId) continue;
    const existing = nextActionByJourney.get(t.journeyId);
    if (!existing || t.dueAt < existing) nextActionByJourney.set(t.journeyId, t.dueAt);
  }

  const treatmentRows = await db
    .select({ journeyId: treatmentOpportunities.journeyId, estimatedValue: treatmentOpportunities.estimatedValue })
    .from(treatmentOpportunities)
    .where(eq(treatmentOpportunities.tenantId, tenantId));
  const treatmentValueByJourney = new Map<string, number>();
  for (const t of treatmentRows) {
    treatmentValueByJourney.set(t.journeyId, (treatmentValueByJourney.get(t.journeyId) ?? 0) + t.estimatedValue);
  }

  const timelineRows = await db
    .select({ journeyId: timelineEvents.journeyId, occurredAt: timelineEvents.occurredAt })
    .from(timelineEvents)
    .where(eq(timelineEvents.tenantId, tenantId));
  const lastActivityByJourney = new Map<string, Date>();
  for (const t of timelineRows) {
    if (!t.journeyId) continue;
    const existing = lastActivityByJourney.get(t.journeyId);
    if (!existing || t.occurredAt > existing) lastActivityByJourney.set(t.journeyId, t.occurredAt);
  }

  let atRiskJourneyIds: Set<string> | null = null;
  if (filters.atRisk) {
    const category = SPEND_AT_RISK_CATEGORIES.find((c) => c.key === filters.atRisk);
    if (category) {
      const atRiskRows = await db
        .select({ journeyId: tasks.journeyId })
        .from(tasks)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "pending"), eq(tasks.reason, category.taskReason as (typeof tasks.reason.enumValues)[number])));
      atRiskJourneyIds = new Set(atRiskRows.map((r) => r.journeyId).filter((id): id is string => id !== null));
    } else {
      atRiskJourneyIds = new Set();
    }
  }

  const withCampaign = rows.map((r) => {
    const campaignId = campaignByJourney.get(r.id) ?? null;
    const campaign = campaignId ? campaignById.get(campaignId) : undefined;
    const acquisitionCost = campaign ? allocatedAcquisitionCost(campaign.spendAmount, enquiryCountByCampaign.get(campaign.id) ?? 0) : null;

    const row: JourneyListRow = {
      id: r.id,
      patientId: r.patientId,
      patientName: r.patientName,
      journeyType: r.journeyType,
      source: r.source,
      campaignName: campaign?.name ?? null,
      stage: r.stage,
      branchName: r.branchName,
      doctorName: doctorByJourney.get(r.id) ?? null,
      ownerName: r.ownerName,
      lastActivityAt: (lastActivityByJourney.get(r.id) ?? r.createdAt).toISOString(),
      nextActionDueAt: nextActionByJourney.get(r.id)?.toISOString() ?? null,
      acquisitionCost,
      treatmentValue: treatmentValueByJourney.get(r.id) ?? 0,
    };
    return { row, campaignId, journeyId: r.id, doctorRef: doctorIdByJourney.get(r.id) ?? null };
  });

  return withCampaign
    .filter((x) => !filters.campaignId || x.campaignId === filters.campaignId)
    .filter((x) => !filters.doctorId || x.doctorRef?.resourceId === filters.doctorId || x.doctorRef?.userId === filters.doctorId)
    .filter((x) => !atRiskJourneyIds || atRiskJourneyIds.has(x.journeyId))
    .map((x) => x.row);
}

export async function getJourneysSummary(db: Db, tenantId: string): Promise<JourneysSummary> {
  const [[active], [apptPending], [consultPending], [treatPending], treatmentRows, spendAtRisk] = await Promise.all([
    db.select({ c: journeys.id }).from(journeys).where(eq(journeys.tenantId, tenantId)).then((r) => [{ c: r.length }]),
    db.select({ c: appointments.id }).from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.status, "scheduled"))).then((r) => [{ c: r.length }]),
    db.select({ c: appointments.id }).from(appointments).where(and(eq(appointments.tenantId, tenantId), eq(appointments.status, "checked_in"))).then((r) => [{ c: r.length }]),
    db.select({ c: treatmentOpportunities.id }).from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.status, "DECISION_PENDING"))).then((r) => [{ c: r.length }]),
    db.select({ estimatedValue: treatmentOpportunities.estimatedValue }).from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.status, "ADVISED"))),
    getSpendAtRisk(db, tenantId),
  ]);

  return {
    activeJourneys: active.c,
    appointmentsPending: apptPending.c,
    consultationsPending: consultPending.c,
    treatmentDecisionsPending: treatPending.c,
    revenueOpportunity: treatmentRows.reduce((sum, t) => sum + t.estimatedValue, 0),
    spendAtRisk: spendAtRisk.total,
  };
}

// ---------------------------------------------------------------------------
// Journey Detail (GET /journeys/:id) — journey-scoped read-model, composed
// from the existing task / timeline / appointment / custom-field readers
// rather than re-deriving them here.
// ---------------------------------------------------------------------------

export interface JourneyViewer {
  id: string;
  role: Role;
  timezone: string;
  /** The hospital runs a revenue workflow. Absent = yes (unchanged behaviour for every other caller). */
  revenueTracking?: boolean;
}

export async function getJourneyDetail(db: Db, tenantId: string, journeyId: string, viewer: JourneyViewer): Promise<JourneyDetailVm | null> {
  // Tenant-scoped in the WHERE clause itself: another tenant's id returns no
  // row, exactly like a nonexistent id.
  const [j] = await db
    .select({
      id: journeys.id,
      patientId: journeys.patientId,
      journeyType: journeys.journeyType,
      stage: journeys.stage,
      source: journeys.source,
      sourceLabel: leadSources.label,
      departmentName: departments.displayName,
      createdAt: journeys.createdAt,
      ownerUserId: journeys.ownerUserId,
      ownerName: users.name,
      patientName: patientNameSql,
      patientDateOfBirth: patients.dateOfBirth,
      patientReportedAge: patients.reportedAge,
      patientPhone: patients.phone,
      branchName: branches.name,
      lastOutcomeLabel: crmOutcomes.label,
      lastOutcomeAt: journeys.lastOutcomeAt,
    })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .leftJoin(branches, eq(patients.branchId, branches.id))
    .leftJoin(users, eq(journeys.ownerUserId, users.id))
    .leftJoin(crmOutcomes, eq(journeys.lastOutcomeId, crmOutcomes.id))
    .leftJoin(leadSources, eq(journeys.sourceId, leadSources.id))
    .leftJoin(departments, eq(journeys.departmentId, departments.id))
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.id, journeyId)))
    .limit(1);
  if (!j) return null;

  const canManageTasks = hasPermission(viewer.role, "MANAGE_TASKS");
  const canViewTasks = canManageTasks || hasPermission(viewer.role, "VIEW_TASKS");
  const canViewTreatment = hasPermission(viewer.role, "VIEW_TREATMENT");
  const canViewRevenue = hasPermission(viewer.role, "VIEW_REVENUE") && viewer.revenueTracking !== false;

  const [firstTouch] = await db
    .select({ campaignId: campaignTouchpoints.campaignId })
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.tenantId, tenantId), eq(campaignTouchpoints.journeyId, journeyId), eq(campaignTouchpoints.touchType, "first_touch")))
    .limit(1);
  let campaign: { id: string; name: string } | null = null;
  if (firstTouch?.campaignId) {
    const [c] = await db
      .select({ id: marketingCampaigns.id, name: marketingCampaigns.name })
      .from(marketingCampaigns)
      .where(and(eq(marketingCampaigns.tenantId, tenantId), eq(marketingCampaigns.id, firstTouch.campaignId)))
      .limit(1);
    campaign = c ?? null;
  }

  // Archived fields keep their recorded values here; fields placed elsewhere or not visible to this role are left out.
  const customFields = await loadJourneyFieldValues(db, tenantId, journeyId, viewer.role, "journey_detail", viewer.timezone);

  const [timeline, taskRows, appointmentRows, nextTask, callStats] = await Promise.all([
    getPatientTimeline(db, tenantId, j.patientId, viewer.role, journeyId),
    canViewTasks
      ? // Same rule as GET /tasks: without MANAGE_TASKS the caller only ever
        // sees tasks assigned to themselves (task notes are PHI-adjacent).
        listTasks(db, tenantId, { patientId: j.patientId, assignedTo: canManageTasks ? undefined : viewer.id }, viewer.timezone)
      : Promise.resolve([]),
    listAppointments(db, tenantId, { journeyId }),
    getNextActionForJourney(db, tenantId, journeyId, viewer.timezone),
    getCallStats(db, tenantId, journeyId),
  ]);
  const journeyTasks = taskRows.filter((t) => t.journeyId === journeyId);

  const latestAppointment = appointmentRows.length > 0 ? appointmentRows[appointmentRows.length - 1] : null; // ordered by scheduledAt asc
  const doctorName = latestAppointment?.doctorName ?? null;
  const lastInteractionAt = timeline.length > 0 ? timeline[timeline.length - 1].occurredAt : j.createdAt.toISOString();
  const nextAction = nextTask ? { dueAt: nextTask.dueAt.toISOString(), label: nextTask.label } : null;
  // The Next Action as a full task (note, owner, priority) — only from tasks this viewer may see, derived the same way.
  const visibleNext = deriveNextAction(
    journeyTasks.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => ({ id: t.id, dueAt: new Date(t.dueAt), priority: t.priority })),
    new Date(),
    viewer.timezone,
  );
  const nextTaskRow = visibleNext ? journeyTasks.find((t) => t.id === visibleNext.task.id) ?? null : null;

  let treatments: TreatmentRow[] | null = null;
  if (canViewTreatment) {
    const rows = await db
      .select({
        id: treatmentOpportunities.id,
        treatmentLabel: treatmentOpportunities.treatmentLabel,
        estimatedValue: treatmentOpportunities.estimatedValue,
        status: treatmentOpportunities.status,
        ownerName: users.name,
        plannedDate: treatmentOpportunities.plannedDate,
        completedAt: treatmentOpportunities.completedAt,
        resourceId: treatmentOpportunities.scheduledResourceId,
        resourceName: scheduleResources.name,
        branchId: treatmentOpportunities.scheduledBranchId,
        branchName: branches.name,
        scheduleNote: treatmentOpportunities.scheduleNote,
      })
      .from(treatmentOpportunities)
      .leftJoin(users, eq(treatmentOpportunities.ownerUserId, users.id))
      .leftJoin(scheduleResources, eq(treatmentOpportunities.scheduledResourceId, scheduleResources.id))
      .leftJoin(branches, eq(treatmentOpportunities.scheduledBranchId, branches.id))
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.journeyId, journeyId)))
      .orderBy(desc(treatmentOpportunities.createdAt));
    treatments = rows.map((r) => ({
      id: r.id,
      patientId: j.patientId,
      patientName: j.patientName,
      journeyId,
      doctorName: r.resourceName ?? doctorName,
      treatmentLabel: r.treatmentLabel,
      service: j.journeyType,
      estimatedValue: r.estimatedValue,
      status: r.status,
      ownerName: r.ownerName,
      nextActionDueAt: nextAction?.dueAt ?? null,
      lastContactAt: lastInteractionAt,
      plannedDate: r.plannedDate?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      branchId: r.branchId,
      branchName: r.branchName,
      scheduleNote: r.scheduleNote,
    }));
  }

  let revenue: JourneyDetailVm["revenue"] = null;
  if (canViewRevenue) {
    const rows = await db
      .select()
      .from(revenueEvents)
      .where(and(eq(revenueEvents.tenantId, tenantId), eq(revenueEvents.journeyId, journeyId)))
      .orderBy(desc(revenueEvents.occurredAt));
    revenue = {
      total: rows.reduce((sum, r) => sum + r.amount, 0),
      events: rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        type: r.type,
        occurredAt: r.occurredAt.toISOString(),
        treatmentOpportunityId: r.treatmentOpportunityId,
      })),
    };
  }

  const operationalStatus = (await loadOperationalStatuses(db, tenantId, [{ id: j.id, stage: j.stage }])).get(j.id) ?? null;

  return {
    patient: { id: j.patientId, name: j.patientName, age: displayAge(j.patientDateOfBirth, j.patientReportedAge, dayKeyIn(new Date(), viewer.timezone)), phone: j.patientPhone, branchName: j.branchName },
    journey: {
      id: j.id,
      journeyType: j.journeyType,
      stage: j.stage,
      operationalStatus,
      source: j.source,
      sourceLabel: j.sourceLabel ?? null,
      departmentName: j.departmentName ?? null,
      campaign,
      owner: j.ownerUserId ? { id: j.ownerUserId, name: j.ownerName ?? "" } : null,
      doctorName,
      createdAt: j.createdAt.toISOString(),
      lastInteractionAt,
      nextAction,
      lastOutcome: j.lastOutcomeLabel && j.lastOutcomeAt ? { label: j.lastOutcomeLabel, at: j.lastOutcomeAt.toISOString() } : null,
      callStats,
      nextTask: nextTaskRow,
      nextTaskBucket: visibleNext?.bucket ?? null,
    },
    customFields,
    timeline,
    tasks: journeyTasks,
    appointments: appointmentRows,
    treatments,
    revenue,
  };
}

// ---------------------------------------------------------------------------
// Journey owner allocation. Changes ONLY journeys.owner_user_id (+ one
// timeline event per journey actually changed). Deliberately never touches
// tasks: open tasks keep their own assignee, reassigning those stays an
// explicit PATCH /tasks/:id/reassign.
// ---------------------------------------------------------------------------

export type AssignJourneyOwnerOutcome =
  | ({ ok: true } & BulkAssignJourneyOwnerResult)
  | { ok: false; reason: "journey_not_found" | "assignee_not_found" };

export async function assignJourneyOwner(
  db: Db,
  tenantId: string,
  actorId: string,
  journeyIds: string[],
  ownerUserId: string | null,
): Promise<AssignJourneyOwnerOutcome> {
  const uniqueIds = [...new Set(journeyIds)];
  if (uniqueIds.length === 0) return { ok: false, reason: "journey_not_found" };

  return db.transaction(async (tx): Promise<AssignJourneyOwnerOutcome> => {
    // Row-locked so two concurrent reassignments can't both record the same "previous owner".
    const rows = await tx
      .select({ id: journeys.id, patientId: journeys.patientId, ownerUserId: journeys.ownerUserId })
      .from(journeys)
      .where(and(eq(journeys.tenantId, tenantId), inArray(journeys.id, uniqueIds)))
      .for("update");
    if (rows.length !== uniqueIds.length) return { ok: false, reason: "journey_not_found" };

    let owner: { id: string; name: string } | null = null;
    if (ownerUserId) {
      const [u] = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.id, ownerUserId)))
        .limit(1);
      if (!u) return { ok: false, reason: "assignee_not_found" };
      owner = u;
    }

    const previousOwnerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((id): id is string => id !== null))];
    const previousOwners = previousOwnerIds.length
      ? await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, previousOwnerIds)))
      : [];
    const previousNameById = new Map(previousOwners.map((u) => [u.id, u.name]));

    const changed = rows.filter((r) => r.ownerUserId !== ownerUserId);
    if (changed.length > 0) {
      await tx
        .update(journeys)
        .set({ ownerUserId })
        .where(and(eq(journeys.tenantId, tenantId), inArray(journeys.id, changed.map((r) => r.id))));
      await tx.insert(timelineEvents).values(
        changed.map((r) => {
          const previousName = r.ownerUserId ? (previousNameById.get(r.ownerUserId) ?? "another user") : null;
          const title = owner
            ? previousName
              ? `Journey owner changed from ${previousName} to ${owner.name}`
              : `Journey assigned to ${owner.name}`
            : `Journey unassigned (was ${previousName})`;
          return {
            tenantId,
            patientId: r.patientId,
            journeyId: r.id,
            actorType: "user" as const,
            actorId,
            eventType: "journey_owner_changed",
            title,
            metadata: { previousOwnerUserId: r.ownerUserId, ownerUserId },
          };
        }),
      );
    }

    return { ok: true, updatedCount: uniqueIds.length, journeyIds: uniqueIds, owner };
  });
}

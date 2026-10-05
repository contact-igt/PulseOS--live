import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { loadOperationalStatuses } from "../journey/operational-status.service.js";
import { displayAge } from "../../lib/age.js";
import { dayKeyIn } from "../../lib/hospital-time.js";
import { patientNameSql } from "../../lib/patient-name.js";
import type { Db } from "../../db/client.js";
import {
  appointments,
  branches,
  campaignTouchpoints,
  journeys,
  marketingCampaigns,
  patients,
  revenueEvents,
  scheduleResources,
  tasks,
  timelineEvents,
  treatmentOpportunities,
  users,
} from "../../db/schema.js";
import { allocatedAcquisitionCost } from "../marketing/formulas.js";
import { getAttributionSummary } from "../acquisition/attribution.service.js";
import { listCallsForPatient } from "../call/call.service.js";
import { resolveOrCreatePatient } from "./identity.service.js";
import type { CreatePatientInput, CreatePatientResult, JourneyCardVm, Patient360, PatientListRow, PatientSearchRow, Role } from "@pulseos/types";
import { loadJourneyFieldValues } from "../crm/crm-field.service.js";

/**
 * Identity-first creation — no Journey, no source/specialty context. For
 * importing/registering an existing hospital patient directly, as distinct
 * from Add Lead (acquisition-first, always creates a Journey). Resolves by
 * phone the same way Add Lead does, through the one shared identity path:
 * never creates a duplicate identity.
 */
export async function createPatient(db: Db, tenantId: string, actorId: string, input: CreatePatientInput): Promise<CreatePatientResult> {
  const { patient, isNewPatient } = await resolveOrCreatePatient(db, {
    tenantId,
    phone: input.phone,
    name: input.name,
    email: input.email,
    preferredLanguage: input.preferredLanguage,
    branchId: input.branchId,
  });

  if (isNewPatient) {
    await db.insert(timelineEvents).values({
      tenantId,
      patientId: patient.id,
      actorType: "user",
      actorId,
      eventType: "patient_created",
      title: "Patient created",
    });
  }

  return { patientId: patient.id, isNewPatient };
}

/**
 * The global-search typeahead's own query — deliberately NOT listPatients,
 * which joins tenant-wide journeys/tasks/timeline for the Patients table and
 * would be a full-directory fetch on every keystroke. Capped and scoped to
 * only what a result row needs: name, phone, and (cheaply, since the result
 * set is already capped to `limit`) each match's most recent journey type.
 */
/**
 * A hospital's own patient identifier (e.g. Namokar UID) is an ordinary CRM text field marked "filterable" and visible to everyone.
 * Typing it in search finds the person it was recorded for, so an existing patient is recognised by their UID as well as by name or
 * phone. Same hospital only (the tenant is on every row); clinical-only fields never take part, so search cannot reveal them.
 */
const matchesIdentifierField = (tenantId: string, text: string) => sql`exists (
  select 1 from journeys j
  join custom_field_values v on v.journey_id = j.id
  join custom_field_definitions d on d.id = v.field_definition_id
  where j.patient_id = ${patients.id} and j.tenant_id = ${tenantId} and d.tenant_id = ${tenantId}
    and d.field_type = 'TEXT' and d.filterable = true and d.visible_to = 'everyone'
    and (v.value #>> '{}') ilike ${`%${text}%`})`;

export async function searchPatients(db: Db, tenantId: string, query: string, limit = 8): Promise<PatientSearchRow[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const rows = await db
    .select({ id: patients.id, name: patientNameSql, phone: patients.phone })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), or(ilike(patients.name, `%${trimmed}%`), ilike(patients.phone, `%${trimmed}%`), matchesIdentifierField(tenantId, trimmed))))
    .orderBy(patients.name)
    .limit(limit);

  if (rows.length === 0) return [];

  const journeyRows = await db
    .select({ patientId: journeys.patientId, journeyType: journeys.journeyType, stage: journeys.stage, createdAt: journeys.createdAt })
    .from(journeys)
    .where(inArray(journeys.patientId, rows.map((r) => r.id)));

  const latestJourneyByPatient = new Map<string, { journeyType: string; stage: (typeof journeyRows)[number]["stage"]; createdAt: Date }>();
  for (const j of journeyRows) {
    const existing = latestJourneyByPatient.get(j.patientId);
    if (!existing || j.createdAt > existing.createdAt) latestJourneyByPatient.set(j.patientId, j);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    currentJourneyType: latestJourneyByPatient.get(r.id)?.journeyType ?? null,
    currentStage: latestJourneyByPatient.get(r.id)?.stage ?? null,
  }));
}

export interface PatientListFilters {
  search?: string;
  branchId?: string;
  source?: string;
  stage?: string;
  ownerId?: string;
}

export async function listPatients(db: Db, tenantId: string, filters: PatientListFilters): Promise<PatientListRow[]> {
  const patientRows = await db
    .select({
      id: patients.id,
      name: patientNameSql,
      phone: patients.phone,
      branchName: branches.name,
    })
    .from(patients)
    .leftJoin(branches, eq(patients.branchId, branches.id))
    .where(
      and(
        eq(patients.tenantId, tenantId),
        filters.branchId ? eq(patients.branchId, filters.branchId) : undefined,
        filters.search ? or(ilike(patients.name, `%${filters.search}%`), ilike(patients.phone, `%${filters.search}%`), matchesIdentifierField(tenantId, filters.search)) : undefined,
      ),
    )
    .orderBy(patients.name);

  const journeyRows = await db
    .select({
      patientId: journeys.patientId,
      id: journeys.id,
      journeyType: journeys.journeyType,
      stage: journeys.stage,
      source: journeys.source,
      ownerUserId: journeys.ownerUserId,
      ownerName: users.name,
      createdAt: journeys.createdAt,
    })
    .from(journeys)
    .leftJoin(users, eq(journeys.ownerUserId, users.id))
    .where(eq(journeys.tenantId, tenantId));

  const taskRows = await db
    .select({ patientId: tasks.patientId, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "pending")));

  const timelineRows = await db
    .select({ patientId: timelineEvents.patientId, occurredAt: timelineEvents.occurredAt })
    .from(timelineEvents)
    .where(eq(timelineEvents.tenantId, tenantId));

  const apptRows = await db
    .select({ patientId: appointments.patientId, status: appointments.status, scheduledAt: appointments.scheduledAt })
    .from(appointments)
    .where(eq(appointments.tenantId, tenantId));

  const journeysByPatient = new Map<string, typeof journeyRows>();
  for (const j of journeyRows) {
    const list = journeysByPatient.get(j.patientId) ?? [];
    list.push(j);
    journeysByPatient.set(j.patientId, list);
  }

  const nextActionByPatient = new Map<string, Date>();
  for (const t of taskRows) {
    const existing = nextActionByPatient.get(t.patientId);
    if (!existing || t.dueAt < existing) nextActionByPatient.set(t.patientId, t.dueAt);
  }

  const lastInteractionByPatient = new Map<string, Date>();
  for (const t of timelineRows) {
    const existing = lastInteractionByPatient.get(t.patientId);
    if (!existing || t.occurredAt > existing) lastInteractionByPatient.set(t.patientId, t.occurredAt);
  }

  const latestApptByPatient = new Map<string, { status: string; scheduledAt: Date }>();
  for (const a of apptRows) {
    const existing = latestApptByPatient.get(a.patientId);
    if (!existing || a.scheduledAt > existing.scheduledAt) latestApptByPatient.set(a.patientId, a);
  }

  const rows = patientRows.map((p) => {
    const patientJourneys = (journeysByPatient.get(p.id) ?? []).filter((j) => j.stage !== "lost");
    const current = [...patientJourneys].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const nextAction = nextActionByPatient.get(p.id);
    const lastInteraction = lastInteractionByPatient.get(p.id);
    const latestAppt = latestApptByPatient.get(p.id);

    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      branchName: p.branchName,
      activeJourneyCount: patientJourneys.length,
      currentJourneyType: current?.journeyType ?? null,
      currentStage: current?.stage ?? null,
      source: current?.source ?? null,
      lastInteractionAt: lastInteraction ? lastInteraction.toISOString() : null,
      nextActionDueAt: nextAction ? nextAction.toISOString() : null,
      ownerName: current?.ownerName ?? null,
      ownerUserId: current?.ownerUserId ?? null,
      appointmentStatus: latestAppt?.status ?? null,
    };
  });

  return rows
    .filter((r) => {
      if (filters.source && r.source !== filters.source) return false;
      if (filters.stage && r.currentStage !== filters.stage) return false;
      if (filters.ownerId && r.ownerUserId !== filters.ownerId) return false;
      return true;
    })
    .map(({ ownerUserId: _ownerUserId, ...rest }) => rest);
}

export async function getPatient360(db: Db, tenantId: string, patientId: string, viewerRole: Role, timezone: string, revenueTracking = true): Promise<Patient360 | null> {
  const [patient] = await db
    .select({ id: patients.id, name: patientNameSql, dateOfBirth: patients.dateOfBirth, reportedAge: patients.reportedAge, phone: patients.phone, preferredLanguage: patients.preferredLanguage, branchName: branches.name })
    .from(patients)
    .leftJoin(branches, and(eq(patients.branchId, branches.id), eq(branches.tenantId, tenantId)))
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)))
    .limit(1);
  if (!patient) return null;

  const journeyRows = await db
    .select({
      id: journeys.id, journeyType: journeys.journeyType, stage: journeys.stage, source: journeys.source,
      ownerName: users.name, createdAt: journeys.createdAt,
    })
    .from(journeys)
    .leftJoin(users, eq(journeys.ownerUserId, users.id))
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.patientId, patientId)))
    .orderBy(desc(journeys.createdAt));

  const operational = await loadOperationalStatuses(db, tenantId, journeyRows.map((j) => ({ id: j.id, stage: j.stage })));
  const journeyCards: JourneyCardVm[] = [];
  for (const j of journeyRows) {
    const [nextTask] = await db
      .select({ dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.journeyId, j.id), eq(tasks.status, "pending")))
      .orderBy(tasks.dueAt)
      .limit(1);

    const [appt] = await db
      .select({ scheduledAt: appointments.scheduledAt, status: appointments.status, doctorName: scheduleResources.name })
      .from(appointments)
      .leftJoin(scheduleResources, eq(appointments.resourceId, scheduleResources.id))
      .where(eq(appointments.journeyId, j.id))
      .orderBy(desc(appointments.scheduledAt))
      .limit(1);

    const [treatment] = await db
      .select({ status: treatmentOpportunities.status, label: treatmentOpportunities.treatmentLabel })
      .from(treatmentOpportunities)
      .where(eq(treatmentOpportunities.journeyId, j.id))
      .orderBy(desc(treatmentOpportunities.createdAt))
      .limit(1);

    const [lastEvent] = await db
      .select({ occurredAt: timelineEvents.occurredAt })
      .from(timelineEvents)
      .where(eq(timelineEvents.journeyId, j.id))
      .orderBy(desc(timelineEvents.occurredAt))
      .limit(1);

    // Archiving retires a field from new entry; values already recorded keep showing here.
    const customFields = await loadJourneyFieldValues(db, tenantId, j.id, viewerRole, "patient_360", timezone);

    journeyCards.push({
      id: j.id,
      journeyType: j.journeyType,
      stage: j.stage,
      operationalStatus: operational.get(j.id) ?? null,
      source: j.source,
      ownerName: j.ownerName,
      nextActionDueAt: nextTask ? nextTask.dueAt.toISOString() : null,
      appointmentTime: appt ? appt.scheduledAt.toISOString() : null,
      appointmentStatus: appt?.status ?? null,
      doctorName: appt?.doctorName ?? null,
      treatmentStatus: treatment?.status ?? null,
      treatmentLabel: treatment?.label ?? null,
      lastInteractionAt: lastEvent ? lastEvent.occurredAt.toISOString() : null,
      customFields,
    });
  }

  // Acquisition context: full attribution (first touch, current last touch,
  // full history count) on the patient's most recent journey — one read
  // surface shared with Campaigns/Command Centre, see
  // acquisition/attribution.service.ts::getAttributionSummary.
  const primaryJourneyId = journeyRows[0]?.id;
  let acquisition: Patient360["acquisition"] = {
    source: journeyRows[0]?.source ?? null,
    campaignName: null,
    firstTouchAt: null,
    allocatedAcquisitionCost: null,
    estimatedTreatmentValue: revenueTracking ? 0 : null,
    attributedRevenue: revenueTracking ? 0 : null,
    touchpointCount: 0,
    lastTouch: null,
  };

  if (primaryJourneyId) {
    const { firstTouch, currentLastTouch, history } = await getAttributionSummary(db, primaryJourneyId);

    let allocatedCost: number | null = null;
    let campaignName: string | null = null;
    if (firstTouch?.campaignId) {
      const [campaign] = await db.select().from(marketingCampaigns).where(eq(marketingCampaigns.id, firstTouch.campaignId)).limit(1);
      if (campaign) {
        campaignName = campaign.name;
        const campaignTouchpointRows = await db
          .select({ id: campaignTouchpoints.id })
          .from(campaignTouchpoints)
          .where(eq(campaignTouchpoints.campaignId, campaign.id));
        allocatedCost = allocatedAcquisitionCost(campaign.spendAmount, campaignTouchpointRows.length);
      }
    }

    const treatmentRows = await db
      .select({ estimatedValue: treatmentOpportunities.estimatedValue })
      .from(treatmentOpportunities)
      .where(eq(treatmentOpportunities.patientId, patientId));
    const estimatedTreatmentValue = treatmentRows.reduce((sum, t) => sum + t.estimatedValue, 0);

    const revenueRows = await db.select({ amount: revenueEvents.amount }).from(revenueEvents).where(eq(revenueEvents.patientId, patientId));
    const attributedRevenue = revenueRows.reduce((sum, r) => sum + r.amount, 0);

    // A journey with only ever one recorded touch has no meaningful "last
    // touch" distinct from the first — surfacing one here would just repeat
    // the same row twice.
    let lastTouch: Patient360["acquisition"]["lastTouch"] = null;
    if (history.length > 1 && currentLastTouch && currentLastTouch.id !== firstTouch?.id) {
      let lastTouchCampaignName: string | null = null;
      if (currentLastTouch.campaignId) {
        const [lastCampaign] = await db.select({ name: marketingCampaigns.name }).from(marketingCampaigns).where(eq(marketingCampaigns.id, currentLastTouch.campaignId)).limit(1);
        lastTouchCampaignName = lastCampaign?.name ?? null;
      }
      lastTouch = { source: currentLastTouch.source, campaignName: lastTouchCampaignName, occurredAt: currentLastTouch.occurredAt.toISOString() };
    }

    acquisition = {
      source: firstTouch?.source ?? journeyRows[0]?.source ?? null,
      campaignName,
      firstTouchAt: firstTouch ? firstTouch.occurredAt.toISOString() : null,
      allocatedAcquisitionCost: allocatedCost,
      estimatedTreatmentValue: revenueTracking ? estimatedTreatmentValue : null,
      attributedRevenue: revenueTracking ? attributedRevenue : null,
      touchpointCount: history.length,
      lastTouch,
    };
  }

  const calls = await listCallsForPatient(db, tenantId, patient.id, viewerRole);

  return {
    patient: { id: patient.id, name: patient.name, age: displayAge(patient.dateOfBirth, patient.reportedAge, dayKeyIn(new Date(), timezone)), dateOfBirth: patient.dateOfBirth, phone: patient.phone, preferredLanguage: patient.preferredLanguage, branchName: patient.branchName },
    journeys: journeyCards,
    calls,
    acquisition,
  };
}

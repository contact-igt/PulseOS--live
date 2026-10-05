import type { Db } from "../../db/client.js";
import { resolveLeadSource } from "../lead/lead-source.service.js";
import { journeys, tasks, timelineEvents } from "../../db/schema.js";
import { findMostRecentActiveJourney, resolveOrCreatePatient } from "../patient/identity.service.js";
import { recordTouchpoint } from "./attribution.service.js";
import { pickOwnerForNewJourney } from "../crm/crm-allocation.service.js";
import type { NormalizedLead } from "./types.js";

export interface IngestLeadOptions {
  branchId?: string | null;
  journeyTypeFallback: string;
  campaignNameFallback: string;
  sourceLabel: string;
  taskDueInHours: number;
  firstTouchEventType: string;
  firstTouchTitle: string;
  additionalTouchEventType: string;
  additionalTouchTitle: string;
  description?: string | null;
  // The connector that produced this lead — stamped on any campaign this
  // ingestion auto-creates, so it stays traceable to its connector's mode
  // (see attribution.service.resolveCampaign).
  connectorId?: string | null;
}

// The single place a NormalizedLead — from any acquisition source (website
// form, Meta Lead Ads, Google Ads Lead Forms) — becomes a Patient, a
// Journey, a Timeline entry, a follow-up Task, and a touchpoint. Uses the
// same canonical identity path as manual Add Lead/Add Patient
// (resolveOrCreatePatient) and reuses the patient's most-recent non-terminal
// journey exactly the way every other inbound connector (WhatsApp, Runo)
// already does — a second lead for the same patient while their enquiry is
// still open is another touch on the SAME journey, not a fabricated new
// one. This is also what makes cross-provider multi-touch attribution
// (Meta then Google on one journey) fall out naturally rather than needing
// special-case logic — see recordTouchpoint.
export async function ingestNormalizedLead(
  db: Db,
  tenantId: string,
  lead: NormalizedLead,
  opts: IngestLeadOptions,
): Promise<{ patientId: string; journeyId: string; touchpointId: string; journeyReused: boolean }> {
  const { patient } = await resolveOrCreatePatient(db, {
    tenantId,
    phone: lead.phone ?? "",
    name: lead.name ?? null,
    branchId: opts.branchId,
  });

  const existingJourney = await findMostRecentActiveJourney(db, tenantId, patient.id);
  // Integrations report a coarse platform value; it resolves to the tenant's catalogue entry of that key, even if
  // the hospital has archived it for manual entry.
  const leadSource = await resolveLeadSource(db, tenantId, lead.source, { allowArchived: true });
  const journeyReused = existingJourney !== null;

  // A brand-new Journey is offered to the allocation rules; a reused one keeps its owner.
  const allocated = existingJourney ? null : await pickOwnerForNewJourney(db, tenantId, { source: lead.source, journeyType: opts.journeyTypeFallback, branchId: opts.branchId });
  const journey = existingJourney ?? (await db
    .insert(journeys)
    .values({
      tenantId,
      patientId: patient.id,
      journeyType: opts.journeyTypeFallback,
      source: lead.source,
      sourceId: leadSource?.id ?? null,
      stage: "enquiry",
      ownerUserId: allocated?.userId ?? null,
    })
    .returning())[0];

  if (allocated) {
    await db.insert(timelineEvents).values({
      tenantId, patientId: patient.id, journeyId: journey.id, actorType: "system", eventType: "journey_auto_assigned",
      title: `Auto-assigned to ${allocated.userName}`, description: `Allocation rule: ${allocated.ruleName}`,
    });
  }

  if (!journeyReused) {
    await db.insert(timelineEvents).values({
      tenantId,
      patientId: patient.id,
      journeyId: journey.id,
      actorType: "system",
      eventType: "journey_created",
      title: `${journey.journeyType} journey opened`,
      sourceChannel: lead.source,
      occurredAt: lead.occurredAt,
    });

    await db.insert(tasks).values({
      tenantId,
      patientId: patient.id,
      journeyId: journey.id,
      // A brand-new, never-touched enquiry — distinct from "manual_task" so
      // a Telecaller Workspace "New Leads" view can filter on it rather than
      // being indistinguishable from any other ad hoc manual task.
      reason: "new_lead",
      type: "CALLBACK",
      priority: "normal",
      status: "pending",
      notes: `New ${opts.sourceLabel} enquiry — first response due`,
      dueAt: new Date(lead.occurredAt.getTime() + opts.taskDueInHours * 60 * 60 * 1000),
    });
  }

  await db.insert(timelineEvents).values({
    tenantId,
    patientId: patient.id,
    journeyId: journey.id,
    actorType: "system",
    eventType: journeyReused ? opts.additionalTouchEventType : opts.firstTouchEventType,
    title: journeyReused ? opts.additionalTouchTitle : opts.firstTouchTitle,
    description: opts.description ?? null,
    sourceChannel: lead.source,
    occurredAt: lead.occurredAt,
  });

  const { touchpointId } = await recordTouchpoint(db, {
    tenantId,
    patientId: patient.id,
    journeyId: journey.id,
    details: lead,
    campaignName: lead.utmCampaign ?? opts.campaignNameFallback,
    connectorId: opts.connectorId,
  });

  return { patientId: patient.id, journeyId: journey.id, touchpointId, journeyReused };
}

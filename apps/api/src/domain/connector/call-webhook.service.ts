import { emitIntegrationEvent } from "../integration/domain-events.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { calls, connectors, journeys, leadSources, tasks, timelineEvents } from "../../db/schema.js";
import { findMostRecentActiveJourney, resolveOrCreatePatient } from "../patient/identity.service.js";
import { getSoleActiveEndpointForConnector, resolveEndpointByCalledNumber } from "./communication-endpoint.service.js";
import { resolveMappedUser } from "./agent-mapping.service.js";
import type { InboundCallEvent } from "./types.js";
import { pickOwnerForNewJourney } from "../crm/crm-allocation.service.js";
import { resolveLeadSource } from "../lead/lead-source.service.js";
import { ensureCallIntelligence } from "../call/call-intelligence.service.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Disposition → Next Action mapping lives on the connector's own (non-secret)
// configuration — "provider disposition mapping should be configurable at
// the Connector layer" — and is restricted to this fixed action vocabulary.
// Arbitrary provider text can never mutate clinical/operational data; only
// these whitelisted actions ever run, and only when the provider's
// disposition string exactly matches a configured key.
export type DispositionAction =
  | { action: "CREATE_CALLBACK_TASK"; dueInDays: number }
  | { action: "ADVANCE_JOURNEY_STAGE"; stage: "booked" | "lost" };

export type DispositionMapping = Record<string, DispositionAction>;

export const DEFAULT_DISPOSITION_MAPPING: DispositionMapping = {
  CALL_BACK_LATER: { action: "CREATE_CALLBACK_TASK", dueInDays: 1 },
  APPOINTMENT_BOOKED: { action: "ADVANCE_JOURNEY_STAGE", stage: "booked" },
  NOT_INTERESTED: { action: "ADVANCE_JOURNEY_STAGE", stage: "lost" },
};

// A missed call has no disposition to key off (the patient never got to
// state one) — previously fell straight through applyDispositionMapping's
// `if (!disposition) return` guard and created nothing at all, for every
// missed call, silently. `missed_follow_up` already existed in
// taskReasonEnum for exactly this case; it was just never used from here.
async function createMissedCallTask(db: Db | Tx, tenantId: string, patientId: string, journeyId: string | null, lineLabel: string | null = null): Promise<void> {
  const journey = journeyId ? await db.select().from(journeys).where(eq(journeys.id, journeyId)).limit(1).then((r) => r[0] ?? null) : null;
  const dueAt = new Date();
  dueAt.setHours(dueAt.getHours() + 2);
  await db.insert(tasks).values({
    tenantId,
    patientId,
    journeyId,
    assignedTo: journey?.ownerUserId ?? null,
    reason: "missed_follow_up",
    type: "CALLBACK",
    priority: "high",
    status: "pending",
    dueAt,
    notes: `Missed call${lineLabel ? ` on ${lineLabel}` : ""} — call back to complete this enquiry`,
  });
}

async function applyDispositionMapping(
  db: Db | Tx,
  tenantId: string,
  patientId: string,
  journeyId: string | null,
  disposition: string | null,
  mapping: DispositionMapping,
): Promise<void> {
  if (!disposition) return;
  const rule = mapping[disposition];
  if (!rule) return;

  if (rule.action === "CREATE_CALLBACK_TASK") {
    const journey = journeyId ? await db.select().from(journeys).where(eq(journeys.id, journeyId)).limit(1).then((r) => r[0] ?? null) : null;
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + rule.dueInDays);
    await db.insert(tasks).values({
      tenantId,
      patientId,
      journeyId,
      assignedTo: journey?.ownerUserId ?? null,
      reason: "overdue_callback",
      type: "CALLBACK",
      priority: "normal",
      status: "pending",
      dueAt,
      notes: `Follow-up call requested (disposition: ${disposition})`,
    });
    return;
  }

  if (rule.action === "ADVANCE_JOURNEY_STAGE" && journeyId) {
    await db.update(journeys).set({ stage: rule.stage }).where(eq(journeys.id, journeyId));
  }
}

/**
 * One provider call event → Patient, Journey (an incoming call from someone with no open enquiry opens one, so the
 * callback has somewhere to live), the Call, its Timeline line, the intelligence row, and the missed-call / disposition
 * Task — in a single transaction. The provider's own call id is unique per connector, so a re-delivery of the same
 * call is a no-op: no second Call, no second Task.
 */
/** What ingesting one call did, as facts safe to log: no phone, no name, no URL, no payload value. */
export interface CallIngestSummary {
  callSaved: boolean;
  duplicate: boolean;
  patient: "created" | "matched";
  journey: "created" | "reused" | "none";
  taskCreated: boolean;
  lineResolved: boolean;
  sourceMapped: boolean;
}

export async function persistInboundCall(db: Db, tenantId: string, connectorId: string, event: InboundCallEvent, mapping: DispositionMapping = DEFAULT_DISPOSITION_MAPPING): Promise<CallIngestSummary> {
  const customerName = (event.metadata.customerName as string | null | undefined) ?? null;
  // The hospital line the call arrived on. A provider that REPORTS the line (CCS) is matched on it, and a reported line
  // that matches nothing stays unresolved: it is never guessed. A provider that does not report one (Runo) can only use the
  // connector's sole active line, a real default, never a pick among several.
  const endpoint = event.calledLine ? await resolveEndpointByCalledNumber(db, tenantId, connectorId, event.calledLine) : await getSoleActiveEndpointForConnector(db, tenantId, connectorId);
  const { patient, isNewPatient } = await resolveOrCreatePatient(db, { tenantId, phone: event.phone, name: customerName, branchId: endpoint?.branchId ?? null });
  const existingJourney = await findMostRecentActiveJourney(db, tenantId, patient.id);
  const [connector] = await db.select({ mode: connectors.mode }).from(connectors).where(eq(connectors.id, connectorId)).limit(1);
  // WHO handled the call (a provider agent mapped to a team member). Recorded on the call only: it never moves the Journey.
  const handledByUserId = await resolveMappedUser(db, tenantId, connectorId, event.agentName);

  // Reads that may advance state outside the transaction: the owner for a brand-new enquiry (round-robin cursor).
  // Attribution comes from what the hospital configured for the line (a campaign, a health camp, the main reception);
  // with no mapping it is Phone, with the provider as the detail. Nothing is assumed to be a digital campaign.
  const openNew = !existingJourney && event.direction === "inbound";
  const mappedSource = openNew && endpoint?.leadSourceId ? (await db.select().from(leadSources).where(and(eq(leadSources.tenantId, tenantId), eq(leadSources.id, endpoint.leadSourceId))).limit(1))[0] ?? null : null;
  const phoneSource = openNew && !mappedSource ? await resolveLeadSource(db, tenantId, "phone", { allowArchived: true }) : null;
  const attributed = mappedSource ?? phoneSource;
  const sourceBucket = attributed?.bucket ?? "phone";
  const sourceDetail = endpoint?.sourceDetail ?? event.providerLabel ?? null;
  const allocated = openNew ? await pickOwnerForNewJourney(db, tenantId, { source: sourceBucket, journeyType: PHONE_ENQUIRY, branchId: endpoint?.branchId ?? null }) : null;

  let stored: { id: string; journeyId: string | null } | null = null;
  let journeyOutcome: CallIngestSummary["journey"] = existingJourney ? "reused" : "none";
  let taskCreated = false;
  await db.transaction(async (tx) => {
    const [insertedCall] = await tx
      .insert(calls)
      .values({
        tenantId,
        origin: "IVR",
        connectorId,
        patientId: patient.id,
        journeyId: existingJourney?.id ?? null,
        communicationEndpointId: endpoint?.id ?? null,
        externalCallId: event.externalCallId,
        direction: event.direction,
        phone: event.phone,
        status: event.status,
        durationSeconds: event.durationSeconds,
        recordingUrl: event.recordingUrl,
        disposition: event.disposition,
        agentName: event.agentName,
        handledByUserId,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        metadata: event.metadata,
      })
      .onConflictDoNothing({ target: [calls.connectorId, calls.externalCallId] })
      .returning();
    if (!insertedCall) return; // already stored: nothing else may run again
    stored = { id: insertedCall.id, journeyId: existingJourney?.id ?? null };

    let journey = existingJourney;
    if (openNew) {
      const [created] = await tx
        .insert(journeys)
        .values({
          tenantId, patientId: patient.id, journeyType: PHONE_ENQUIRY, source: sourceBucket, sourceId: attributed?.id ?? null, sourceDetail, departmentId: endpoint?.departmentId ?? null, stage: "enquiry",
          ownerUserId: allocated?.userId ?? null, createdAt: event.startedAt ?? new Date(),
        })
        .returning();
      journey = created!;
      journeyOutcome = "created";
      await tx.update(calls).set({ journeyId: journey.id }).where(eq(calls.id, insertedCall.id));
      await tx.insert(timelineEvents).values({
        tenantId, patientId: patient.id, journeyId: journey.id, actorType: "system", eventType: "journey_created", title: `${PHONE_ENQUIRY} journey opened`,
        sourceChannel: "phone", channel: "IVR_CALL", occurredAt: event.startedAt ?? new Date(),
      });
      if (allocated) {
        await tx.insert(timelineEvents).values({ tenantId, patientId: patient.id, journeyId: journey.id, actorType: "system", eventType: "journey_auto_assigned", title: `Auto-assigned to ${allocated.userName}`, description: `Allocation rule: ${allocated.ruleName}` });
      }
    }

    await tx.insert(timelineEvents).values({
      tenantId,
      patientId: patient.id,
      journeyId: journey?.id ?? null,
      actorType: "system",
      eventType: "call_logged",
      channel: "IVR_CALL",
      title: callTitle(event),
      description: callDescription(event, endpoint?.displayLabel ?? null),
      occurredAt: event.endedAt ?? event.startedAt ?? new Date(),
      // Traceable back to its own `calls` row (relatedEntityType + relatedEntityId together).
      relatedEntityType: "call",
      relatedEntityId: insertedCall.id,
    });

    await ensureCallIntelligence(tx, { id: insertedCall.id, tenantId, hasRecording: !!event.recordingUrl }, { connectorMode: connector?.mode ?? null, providerTranscript: event.transcript });

    // Mutually exclusive, not "also": a missed call's disposition (if any
    // provider ever sends one) doesn't reflect a real conversation, so it
    // must never ALSO trigger a disposition-mapped task — that would double
    // up the follow-up task for one missed call.
    if (event.status === "missed") {
      taskCreated = true;
      await createMissedCallTask(tx, tenantId, patient.id, journey?.id ?? null, endpoint?.displayLabel ?? null);
    } else {
      await applyDispositionMapping(tx, tenantId, patient.id, journey?.id ?? null, event.disposition, mapping);
    }
  });
  const call = stored as { id: string; journeyId: string | null } | null;
  if (call && (event.status === "completed" || event.status === "missed")) {
    emitIntegrationEvent({ type: event.status === "completed" ? "call.completed" : "call.missed", tenantId, eventId: `call.${event.status}:${call.id}`, occurredAt: event.endedAt ?? event.startedAt ?? new Date(), data: { callId: call.id, journeyId: call.journeyId, direction: event.direction } });
  }
  return {
    callSaved: !!call,
    duplicate: !call,
    patient: isNewPatient ? "created" : "matched",
    journey: call ? journeyOutcome : existingJourney ? "reused" : "none",
    taskCreated: !!call && taskCreated,
    lineResolved: !!endpoint,
    sourceMapped: !!mappedSource,
  };
}

const PHONE_ENQUIRY = "Phone enquiry";

/** "1m 26s", "45s", "1h 2m 3s". */
export function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : "", s || (!h && !m) ? `${s}s` : ""].filter(Boolean).join(" ");
}

// "Incoming IVR call · Answered by Shivani". Answered is not attended: this line records a call, nothing more.
export function callTitle(event: Pick<InboundCallEvent, "direction" | "status" | "agentName">): string {
  if (event.status === "missed") return event.direction === "inbound" ? "Missed IVR call" : "Outgoing IVR call · Missed";
  const kind = event.direction === "inbound" ? "Incoming IVR call" : "Outgoing IVR call";
  const outcome = { completed: `Answered${event.agentName ? ` by ${event.agentName}` : ""}`, no_answer: "No answer", busy: "Busy", failed: "Failed" }[event.status];
  return `${kind} · ${outcome}`;
}

function callDescription(event: Pick<InboundCallEvent, "status" | "durationSeconds">, lineLabel: string | null): string | null {
  const parts = [event.status === "completed" && event.durationSeconds ? `Duration · ${formatCallDuration(event.durationSeconds)}` : null, lineLabel ? `Line · ${lineLabel}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

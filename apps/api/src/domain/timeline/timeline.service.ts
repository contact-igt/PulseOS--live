import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { timelineEvents, calls, conversations, communicationEndpoints, conversationSummaries } from "../../db/schema.js";
import type { Role, SummaryMode, TimelineEventVm } from "@pulseos/types";
import { loadCallVms } from "../call/call.service.js";

const CATEGORY_BY_EVENT_TYPE: Record<string, "communication" | "appointments" | "clinical" | "tasks" | "other"> = {
  journey_created: "other",
  source_captured: "other",
  whatsapp_message: "communication",
  whatsapp_sent: "communication",
  whatsapp_conversation: "communication",
  call_logged: "communication",
  note_added: "communication",
  appointment_scheduled: "appointments",
  appointment_confirmed: "appointments",
  appointment_checked_in: "appointments",
  appointment_waiting: "appointments",
  appointment_with_doctor: "appointments",
  appointment_completed: "appointments",
  appointment_no_show: "appointments",
  appointment_rescheduled: "appointments",
  appointment_cancelled: "appointments",
  consultation_outcome_recorded: "clinical",
  treatment_status_changed: "clinical",
  surgery_scheduled: "clinical",
  surgery_rescheduled: "clinical",
  appointment_created: "appointments",
  revenue_recorded: "clinical",
  task_created: "tasks",
  task_completed: "tasks",
  journey_owner_changed: "tasks",
  journey_auto_assigned: "tasks",
  outcome_logged: "communication",
  conversation_claimed: "communication",
  conversation_assigned: "communication",
  conversation_closed: "communication",
  conversation_returned_to_ai: "communication",
};

export async function getPatientTimeline(db: Db, tenantId: string, patientId: string, viewerRole: Role, journeyId?: string): Promise<TimelineEventVm[]> {
  const rows = await db
    .select()
    .from(timelineEvents)
    .where(
      and(
        eq(timelineEvents.tenantId, tenantId),
        eq(timelineEvents.patientId, patientId),
        journeyId ? eq(timelineEvents.journeyId, journeyId) : undefined,
      ),
    )
    .orderBy(asc(timelineEvents.occurredAt));

  const endpointLabelByEventId = await resolveEndpointLabels(db, tenantId, rows);
  const summaryModeByEventId = await resolveSummaryModes(db, tenantId, rows);
  // A call line carries the call itself (IVR and manual alike), trimmed to what this viewer may see.
  const callIds = rows.filter((r) => r.eventType === "call_logged" && r.relatedEntityType === "call" && r.relatedEntityId).map((r) => r.relatedEntityId!);
  const callById = new Map((callIds.length ? await loadCallVms(db, tenantId, inArray(calls.id, callIds), viewerRole) : []).map((c) => [c.id, c]));

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    title: r.title,
    description: r.description,
    sourceChannel: r.sourceChannel,
    occurredAt: r.occurredAt.toISOString(),
    category: CATEGORY_BY_EVENT_TYPE[r.eventType] ?? "other",
    relatedEntityType: r.relatedEntityType,
    relatedEntityId: r.relatedEntityId,
    endpointLabel: endpointLabelByEventId.get(r.id) ?? null,
    channel: r.channel,
    call: (r.eventType === "call_logged" && r.relatedEntityId ? callById.get(r.relatedEntityId) : null) ?? null,
    summaryMode: summaryModeByEventId.get(r.id) ?? null,
  }));
}

// A conversation-session line carries its summary id in metadata once one exists; the mode comes from that
// summary row, so the UI can say a summary is FIXTURE/AI instead of implying every one is model-written.
async function resolveSummaryModes(db: Db, tenantId: string, rows: { id: string; metadata: unknown }[]): Promise<Map<string, SummaryMode>> {
  const summaryIdByEventId = new Map<string, string>();
  for (const r of rows) {
    const id = (r.metadata as { summaryId?: unknown } | null)?.summaryId;
    if (typeof id === "string") summaryIdByEventId.set(r.id, id);
  }
  if (summaryIdByEventId.size === 0) return new Map();
  const found = await db
    .select({ id: conversationSummaries.id, mode: conversationSummaries.mode })
    .from(conversationSummaries)
    .where(and(eq(conversationSummaries.tenantId, tenantId), inArray(conversationSummaries.id, [...new Set(summaryIdByEventId.values())])));
  const modeBySummaryId = new Map(found.map((f) => [f.id, f.mode as SummaryMode]));
  const out = new Map<string, SummaryMode>();
  for (const [eventId, summaryId] of summaryIdByEventId) {
    const mode = modeBySummaryId.get(summaryId);
    if (mode) out.set(eventId, mode);
  }
  return out;
}

// A call/conversation-related Timeline event never resolves its own
// endpoint — it exposes the SAME communicationEndpointId already stamped on
// the `calls`/`conversations` row it points at (relatedEntityType +
// relatedEntityId), stamped once at ingest time (see
// call-webhook.service.ts / whatsapp-webhook.service.ts). No guessing here,
// only a lookup of what those rows already resolved.
async function resolveEndpointLabels(
  db: Db,
  tenantId: string,
  rows: { id: string; relatedEntityType: string | null; relatedEntityId: string | null }[],
): Promise<Map<string, string>> {
  const callIds = rows.filter((r) => r.relatedEntityType === "call" && r.relatedEntityId).map((r) => r.relatedEntityId!);
  const conversationIds = rows.filter((r) => r.relatedEntityType === "conversation" && r.relatedEntityId).map((r) => r.relatedEntityId!);
  if (callIds.length === 0 && conversationIds.length === 0) return new Map();

  const [callLabels, conversationLabels] = await Promise.all([
    callIds.length
      ? db
          .select({ id: calls.id, label: communicationEndpoints.displayLabel })
          .from(calls)
          .leftJoin(communicationEndpoints, eq(calls.communicationEndpointId, communicationEndpoints.id))
          .where(and(eq(calls.tenantId, tenantId), inArray(calls.id, callIds)))
      : [],
    conversationIds.length
      ? db
          .select({ id: conversations.id, label: communicationEndpoints.displayLabel })
          .from(conversations)
          .leftJoin(communicationEndpoints, eq(conversations.communicationEndpointId, communicationEndpoints.id))
          .where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, conversationIds)))
      : [],
  ]);

  const labelByEntityId = new Map<string, string>();
  for (const row of [...callLabels, ...conversationLabels]) {
    if (row.label) labelByEntityId.set(row.id, row.label);
  }

  const labelByEventId = new Map<string, string>();
  for (const r of rows) {
    if (r.relatedEntityId) {
      const label = labelByEntityId.get(r.relatedEntityId);
      if (label) labelByEventId.set(r.id, label);
    }
  }
  return labelByEventId;
}

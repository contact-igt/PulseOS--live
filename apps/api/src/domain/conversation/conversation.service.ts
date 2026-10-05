import { and, asc, desc, eq, gte, inArray, or } from "drizzle-orm";
import { patientNameSql } from "../../lib/patient-name.js";
import type { Db } from "../../db/client.js";
import { appointments, communicationEndpoints, conversationAutomationPreferences, conversations, journeys, messages, patients, tasks, timelineEvents, users } from "../../db/schema.js";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getMessagingAdapter } from "../connector/registry.js";
import { eligibleAssignee } from "../task/task.service.js";
import { getConversationSummaryState, recordConversationActivity } from "./summary/conversation-session.service.js";
import type { ConversationAutomationMode, ConversationAutomationPreference, ConversationChannel, ConversationDetail, ConversationRow, OwnershipState } from "@pulseos/types";

export interface ConversationFilters {
  channel?: ConversationChannel;
  ownershipState?: OwnershipState;
  search?: string;
  communicationEndpointId?: string;
}

export async function listConversations(db: Db, tenantId: string, filters: ConversationFilters): Promise<ConversationRow[]> {
  const rows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      patientName: patientNameSql,
      channel: conversations.channel,
      ownershipState: conversations.ownershipState,
      ownerName: users.name,
      lastMessageAt: conversations.lastMessageAt,
      endpointLabel: communicationEndpoints.displayLabel,
    })
    .from(conversations)
    .innerJoin(patients, eq(conversations.patientId, patients.id))
    .leftJoin(users, eq(conversations.assignedTo, users.id))
    .leftJoin(communicationEndpoints, eq(conversations.communicationEndpointId, communicationEndpoints.id))
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        filters.channel ? eq(conversations.channel, filters.channel) : undefined,
        filters.ownershipState ? eq(conversations.ownershipState, filters.ownershipState) : undefined,
        filters.communicationEndpointId ? eq(conversations.communicationEndpointId, filters.communicationEndpointId) : undefined,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt));

  const search = filters.search?.trim().toLowerCase();
  const filtered = search ? rows.filter((r) => r.patientName.toLowerCase().includes(search)) : rows;
  if (filtered.length === 0) return [];

  const conversationIds = filtered.map((r) => r.id);
  const messageRows = await db
    .select({ conversationId: messages.conversationId, senderType: messages.senderType, body: messages.body, sentAt: messages.sentAt, readAt: messages.readAt })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds));

  const lastByConv = new Map<string, { body: string; sentAt: Date }>();
  const unreadByConv = new Map<string, number>();
  for (const m of messageRows) {
    const existing = lastByConv.get(m.conversationId);
    if (!existing || m.sentAt > existing.sentAt) lastByConv.set(m.conversationId, { body: m.body, sentAt: m.sentAt });
    if (m.senderType === "patient" && !m.readAt) unreadByConv.set(m.conversationId, (unreadByConv.get(m.conversationId) ?? 0) + 1);
  }

  return filtered.map((r) => ({
    id: r.id,
    patientId: r.patientId,
    patientName: r.patientName,
    channel: r.channel,
    lastMessage: lastByConv.get(r.id)?.body ?? null,
    lastMessageAt: r.lastMessageAt.toISOString(),
    unreadCount: unreadByConv.get(r.id) ?? 0,
    ownerName: r.ownerName,
    ownershipState: r.ownershipState,
    endpointLabel: r.endpointLabel,
  }));
}

export async function getConversationDetail(db: Db, tenantId: string, conversationId: string): Promise<ConversationDetail | null> {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId))).limit(1);
  if (!conv) return null;

  const [patient] = await db.select({ name: patientNameSql }).from(patients).where(eq(patients.id, conv.patientId)).limit(1);
  const [assignedUser] = conv.assignedTo
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, conv.assignedTo)).limit(1)
    : [null];
  const [endpoint] = conv.communicationEndpointId
    ? await db.select({ displayLabel: communicationEndpoints.displayLabel }).from(communicationEndpoints).where(eq(communicationEndpoints.id, conv.communicationEndpointId)).limit(1)
    : [null];

  const unreadIds = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, "patient")));
  if (unreadIds.length > 0) {
    await db.update(messages).set({ readAt: new Date() }).where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, "patient")));
  }

  const messageRows = await db
    .select({ id: messages.id, senderType: messages.senderType, senderName: users.name, body: messages.body, sentAt: messages.sentAt })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt));

  let journeyId = conv.journeyId;
  if (!journeyId) {
    const [latestJourney] = await db.select({ id: journeys.id }).from(journeys).where(eq(journeys.patientId, conv.patientId)).orderBy(desc(journeys.createdAt)).limit(1);
    journeyId = latestJourney?.id ?? null;
  }

  let patientContext: ConversationDetail["patientContext"] = null;
  if (journeyId) {
    const [journey] = await db
      .select({ journeyType: journeys.journeyType, stage: journeys.stage, ownerName: users.name })
      .from(journeys)
      .leftJoin(users, eq(journeys.ownerUserId, users.id))
      .where(eq(journeys.id, journeyId))
      .limit(1);

    const [nextTask] = await db
      .select({ dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.patientId, conv.patientId), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress"))))
      .orderBy(asc(tasks.dueAt))
      .limit(1);

    const [lastEvent] = await db
      .select({ occurredAt: timelineEvents.occurredAt })
      .from(timelineEvents)
      .where(eq(timelineEvents.patientId, conv.patientId))
      .orderBy(desc(timelineEvents.occurredAt))
      .limit(1);

    const [nextAppt] = await db
      .select({ scheduledAt: appointments.scheduledAt })
      .from(appointments)
      .where(and(eq(appointments.journeyId, journeyId), gte(appointments.scheduledAt, new Date())))
      .orderBy(asc(appointments.scheduledAt))
      .limit(1);

    patientContext = {
      patientId: conv.patientId,
      journeyType: journey?.journeyType ?? null,
      stage: journey?.stage ?? null,
      ownerName: journey?.ownerName ?? null,
      appointmentTime: nextAppt?.scheduledAt.toISOString() ?? null,
      lastInteractionAt: lastEvent?.occurredAt.toISOString() ?? null,
      nextActionDueAt: nextTask?.dueAt.toISOString() ?? null,
    };
  }

  return {
    conversation: {
      id: conv.id,
      patientId: conv.patientId,
      patientName: patient?.name ?? "",
      channel: conv.channel,
      lastMessage: messageRows.at(-1)?.body ?? null,
      lastMessageAt: conv.lastMessageAt.toISOString(),
      unreadCount: 0,
      ownerName: assignedUser?.name ?? null,
      ownershipState: conv.ownershipState,
      endpointLabel: endpoint?.displayLabel ?? null,
    },
    messages: messageRows.map((m) => ({ id: m.id, senderType: m.senderType, senderName: m.senderName, body: m.body, sentAt: m.sentAt.toISOString() })),
    patientContext,
    summary: await getConversationSummaryState(db, conv),
    // WhatsApp customer-service window: free-form replies are only allowed for 24h after the patient's last message.
    serviceWindowExpiresAt: conv.lastPatientInboundAt ? new Date(conv.lastPatientInboundAt.getTime() + 24 * 3600_000).toISOString() : null,
  };
}

async function findConversation(db: Db, tenantId: string, conversationId: string) {
  const [existing] = await db.select().from(conversations).where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId))).limit(1);
  return existing ?? null;
}

export async function claimConversation(db: Db, tenantId: string, conversationId: string, actorId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (existing.ownershipState === "CLOSED") return { ok: false, reason: "conversation_closed" };

  await db.update(conversations).set({ ownershipState: "HUMAN_ACTIVE", assignedTo: actorId }).where(eq(conversations.id, conversationId));
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "conversation_claimed", title: "Conversation claimed",
  });
  return { ok: true };
}

export async function assignConversation(
  db: Db,
  tenantId: string,
  conversationId: string,
  actorId: string,
  assignedTo: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (existing.ownershipState === "CLOSED") return { ok: false, reason: "conversation_closed" };

  // The assignee must be staff of THIS hospital — a foreign id is refused, never stored or named on the timeline.
  const assignee = await eligibleAssignee(db, tenantId, assignedTo);
  if (!assignee) return { ok: false, reason: "assignee_not_found" };
  await db.update(conversations).set({ ownershipState: "HUMAN_ASSIGNED", assignedTo }).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "conversation_assigned",
    title: assignee ? `Conversation assigned to ${assignee.name}` : "Conversation assigned",
  });
  return { ok: true };
}

// No AI runtime exists yet in this checkpoint. "Return to AI" must never
// pretend the AI has actually resumed — it hands the conversation into
// AI_RESUME_PENDING, a real, honest queued-for-AI state. The eventual agent
// runtime checkpoint is what actually resolves AI_RESUME_PENDING -> AI_ACTIVE;
// until then a human can always reclaim it (see claimConversation, which
// accepts any non-CLOSED state).
export async function returnConversationToAi(db: Db, tenantId: string, conversationId: string, actorId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (existing.ownershipState === "CLOSED") return { ok: false, reason: "conversation_closed" };

  await db.update(conversations).set({ ownershipState: "AI_RESUME_PENDING", assignedTo: null }).where(eq(conversations.id, conversationId));
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "conversation_returned_to_ai", title: "Returned to AI (pending resume)",
  });
  return { ok: true };
}

export async function closeConversation(db: Db, tenantId: string, conversationId: string, actorId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (existing.ownershipState === "CLOSED") return { ok: false, reason: "conversation_closed" };

  await db.update(conversations).set({ ownershipState: "CLOSED" }).where(eq(conversations.id, conversationId));
  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "conversation_closed", title: "Conversation closed",
  });
  return { ok: true };
}

const AUTOMATION_MODE_LABEL: Record<ConversationAutomationMode, string> = {
  manual: "Manual only",
  ai_when_available: "AI when available",
  ai_scheduled: "AI scheduled",
};

function toAutomationPreference(row: {
  mode: ConversationAutomationMode; scheduledStart: Date | null; scheduledEnd: Date | null; timezone: string | null; updatedBy: string | null; updatedAt: Date;
} | null): ConversationAutomationPreference {
  if (!row) return { mode: "manual", scheduledStart: null, scheduledEnd: null, timezone: null, updatedBy: null, updatedAt: null };
  return {
    mode: row.mode,
    scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
    scheduledEnd: row.scheduledEnd ? row.scheduledEnd.toISOString() : null,
    timezone: row.timezone,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getConversationAutomation(db: Db, tenantId: string, conversationId: string): Promise<ConversationAutomationPreference | null> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return null;

  const [row] = await db.select().from(conversationAutomationPreferences).where(eq(conversationAutomationPreferences.conversationId, conversationId)).limit(1);
  return toAutomationPreference(row ?? null);
}

export interface SetConversationAutomationInput {
  mode: ConversationAutomationMode;
  scheduledStart?: string;
  scheduledEnd?: string;
  timezone?: string;
}

export async function setConversationAutomation(
  db: Db,
  tenantId: string,
  conversationId: string,
  actorId: string,
  input: SetConversationAutomationInput,
): Promise<{ ok: true; preference: ConversationAutomationPreference } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (input.mode === "ai_scheduled" && (!input.scheduledStart || !input.scheduledEnd || !input.timezone)) {
    return { ok: false, reason: "schedule_required" };
  }

  const scheduledStart = input.mode === "ai_scheduled" && input.scheduledStart ? new Date(input.scheduledStart) : null;
  const scheduledEnd = input.mode === "ai_scheduled" && input.scheduledEnd ? new Date(input.scheduledEnd) : null;
  const timezone = input.mode === "ai_scheduled" ? (input.timezone ?? null) : null;

  const [row] = await db
    .insert(conversationAutomationPreferences)
    .values({ tenantId, conversationId, mode: input.mode, scheduledStart, scheduledEnd, timezone, updatedBy: actorId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: conversationAutomationPreferences.conversationId,
      set: { mode: input.mode, scheduledStart, scheduledEnd, timezone, updatedBy: actorId, updatedAt: new Date() },
    })
    .returning();

  await db.insert(timelineEvents).values({
    tenantId, patientId: existing.patientId, journeyId: existing.journeyId,
    actorType: "user", actorId, eventType: "conversation_automation_updated",
    title: `AI scheduling preference set to ${AUTOMATION_MODE_LABEL[input.mode]}`,
  });

  return { ok: true, preference: toAutomationPreference(row) };
}

export async function sendMessage(db: Db, tenantId: string, conversationId: string, actorId: string, body: string, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };


  // Route through the live provider when this conversation is connector-
  // backed (Group T). Demo-seed conversations have no connectorId and stay
  // purely local, as before.
  let providerMessageId: string | null = null;
  let deliveryStatus: "sent" | "failed" | null = null;
  if (existing.connectorId) {
    const connector = await getConnectorById(db, existing.connectorId);
    const adapter = connector ? getMessagingAdapter(connector.provider) : null;
    if (connector && adapter) {
      const [patient] = await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, existing.patientId)).limit(1);
      const to = existing.externalThreadId ?? patient?.phone;
      const secrets = to ? await getConnectorSecrets(db, connector.id) : null;
      if (to && secrets) {
        try {
          // mode must be stamped onto config exactly like campaign-sync.service.ts
          // does for its adapter calls — without it, config.mode is undefined, every
          // adapter's `if (config.mode === "fixture")` guard is skipped, and a FIXTURE
          // connector attempts a real provider API call with fixture secrets. That
          // always fails, which permanently flips the connector to ERROR via
          // touchConnectorError below — the actual root cause of a previously
          // observed flake where connector-checkpoint's own live-reply step
          // corrupted connector status for any later run against the same DB.
          const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase() };
          // The Inbox/Patient 360 UI shows which hospital line this thread
          // resolved to (e.g. "Fertility Line") — a reply must actually be
          // sent from that same line, not silently fall back to the
          // connector's single default `phoneNumberId`, or the UI would be
          // asserting a delivery line the send path doesn't honour. For
          // WhatsApp, providerRef IS the real phone_number_id (see
          // communication-endpoint.service.ts) — safe to override generic
          // config here since every other adapter ignores an unknown key.
          if (existing.communicationEndpointId) {
            const [endpoint] = await db
              .select({ providerRef: communicationEndpoints.providerRef })
              .from(communicationEndpoints)
              .where(eq(communicationEndpoints.id, existing.communicationEndpointId))
              .limit(1);
            if (endpoint) config.phoneNumberId = endpoint.providerRef;
          }
          const sent = await adapter.sendMessage(config, secrets, to, body);
          providerMessageId = sent.providerMessageId;
          deliveryStatus = "sent";
          await touchConnectorSuccess(db, connector.id);
        } catch (err) {
          deliveryStatus = "failed";
          await touchConnectorError(db, connector.id, (err as Error).message);
        }
      }
    }
  }

  await db.insert(messages).values({
    tenantId,
    conversationId,
    senderType: "staff",
    senderUserId: actorId,
    body,
    sentAt: now,
    connectorId: existing.connectorId,
    providerMessageId,
    deliveryStatus,
  });
  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversationId));

  // Staff messages are part of the same conversation session as the patient's: one Timeline line for the
  // session, and the idle deadline is pushed out (even when delivery failed — the thread still moved).
  await recordConversationActivity(db, tenantId, conversationId, { at: now, sender: "staff" });

  return { ok: true };
}

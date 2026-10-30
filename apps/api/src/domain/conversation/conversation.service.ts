import { and, asc, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import crypto from "node:crypto";
import type { Db } from "../../db/client.js";
import { appointments, communicationEndpoints, conversationAutomationPreferences, conversations, journeys, messageAttachments, messages, patients, tasks, timelineEvents, users } from "../../db/schema.js";
import { getConnectorById, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getMessagingAdapter } from "../connector/registry.js";
import type { MessagingProviderAdapter } from "../connector/types.js";
import { redactLogText } from "../security/redact.js";
import { eligibleAssignee } from "../task/task.service.js";
import { getConversationSummaryState, recordConversationActivity } from "./summary/conversation-session.service.js";
import { checkMediaFile, type ConversationAutomationMode, type ConversationAutomationPreference, type ConversationChannel, type ConversationDetail, type ConversationRow, type MessageAttachmentKind, type MessageDeliveryStatus, type OwnershipState, type SendMessageResult } from "@pulseos/types";
import { resolvesToPublicAddresses, validateWebhookUrl, webhookAllowInsecure } from "../integration/webhook-rules.js";

export interface ConversationFilters {
  channel?: ConversationChannel;
  ownershipState?: OwnershipState;
  search?: string;
  communicationEndpointId?: string;
}

// Inbox needs a usable distinction between unnamed contacts; elsewhere the
// standard "Unknown patient" label remains unchanged.
const inboxPatientNameSql = sql<string>`coalesce(nullif(btrim(${patients.name}), ''), concat('Unknown (', ${patients.phone}, ')'))`;

export async function listConversations(db: Db, tenantId: string, filters: ConversationFilters): Promise<ConversationRow[]> {
  const rows = await db
    .select({
      id: conversations.id,
      patientId: conversations.patientId,
      patientName: inboxPatientNameSql,
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

  const [patient] = await db.select({ name: inboxPatientNameSql }).from(patients).where(eq(patients.id, conv.patientId)).limit(1);
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
    // A PulseOS team member's name, or the name of the WhatsNexus agent who wrote it there.
    .select({ id: messages.id, senderType: messages.senderType, senderName: sql<string | null>`coalesce(${users.name}, ${messages.senderName})`, body: messages.body, sentAt: messages.sentAt, deliveryStatus: messages.deliveryStatus, kind: messages.kind, templateName: messages.templateName })
    .from(messages)
    .leftJoin(users, eq(messages.senderUserId, users.id))
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sentAt));
  const attachmentRows = messageRows.length
    ? await db.select().from(messageAttachments).where(inArray(messageAttachments.messageId, messageRows.map((m) => m.id)))
    : [];
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const attachment of attachmentRows) {
    const list = attachmentsByMessage.get(attachment.messageId) ?? [];
    list.push(attachment);
    attachmentsByMessage.set(attachment.messageId, list);
  }

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
    messages: messageRows.map((m) => ({
      id: m.id, senderType: m.senderType, senderName: m.senderName, body: m.body, sentAt: m.sentAt.toISOString(), deliveryStatus: m.deliveryStatus, kind: m.kind === "template" ? "template" : "text", templateName: m.templateName,
      attachments: (attachmentsByMessage.get(m.id) ?? []).map((a) => ({ id: a.id, kind: a.kind, fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    })),
    patientContext,
    summary: await getConversationSummaryState(db, conv),
    // WhatsApp customer-service window: free-form replies are only allowed for 24h after the patient's last message.
    serviceWindowExpiresAt: conv.lastPatientInboundAt ? new Date(conv.lastPatientInboundAt.getTime() + 24 * 3600_000).toISOString() : null,
    // The same rule sendMessage enforces, so the Inbox can say so before anyone types a reply that could not be sent.
    replyBlockedReason: conv.connectorId && windowClosed(conv, new Date()) ? "WINDOW_CLOSED" : null,
  };
}

async function findAttachment(db: Db, tenantId: string, conversationId: string, messageId: string, attachmentId: string) {
  const [attachment] = await db
    .select({ providerMediaId: messageAttachments.providerMediaId, fileName: messageAttachments.fileName, mimeType: messageAttachments.mimeType, connectorId: messages.connectorId })
    .from(messageAttachments)
    .innerJoin(messages, eq(messageAttachments.messageId, messages.id))
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(and(eq(messageAttachments.id, attachmentId), eq(messages.id, messageId), eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
    .limit(1);
  return attachment ?? null;
}

/** A provider URL valid for five minutes, signed for this hospital; the media id never reaches the UI data model. Server-side only. */
export async function getConversationAttachmentUrl(db: Db, tenantId: string, conversationId: string, messageId: string, attachmentId: string): Promise<string | null> {
  const attachment = await findAttachment(db, tenantId, conversationId, messageId, attachmentId);
  if (!attachment?.connectorId) return null;
  const connector = await getConnectorById(db, attachment.connectorId);
  if (!connector || connector.tenantId !== tenantId || connector.provider !== "whatsnexus") return null;
  const configuration = (connector.configuration as Record<string, unknown> | null) ?? {};
  const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl : "";
  const providerTenantId = typeof configuration.tenantId === "string" ? configuration.tenantId : "";
  const callbackSecret = (await getConnectorSecrets(db, connector.id))?.callbackSecret;
  if (!baseUrl || !providerTenantId || typeof callbackSecret !== "string") return null;
  const expires = Math.floor(Date.now() / 1000) + 5 * 60;
  const signature = `sha256=${createHmac("sha256", callbackSecret).update(`${expires}.${providerTenantId}.${attachment.providerMediaId}`).digest("hex")}`;
  const url = new URL(`/api/integrations/pulseos/media/${encodeURIComponent(attachment.providerMediaId)}`, baseUrl);
  url.searchParams.set("tenantId", providerTenantId);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signature);
  return url.toString();
}

/** Types a browser may show inline; everything else is offered as a download so a file can never run as a page of PulseOS. */
const INLINE_MEDIA = /^(image\/(jpeg|png|webp|gif)|audio\/[a-z0-9.+-]+|video\/mp4|application\/pdf)$/;

export interface AttachmentStream {
  status: 200 | 206;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Open an attachment for the Inbox. PulseOS fetches it from the provider itself (with the short-lived signed link) and relays
 * it, instead of sending the browser to the provider: that keeps the signed link private, works whatever the provider's host
 * does to browsers (a tunnel's warning page, CORS), supports audio/video seeking (Range), and enforces the hospital check
 * here. Null when it is not this hospital's, no longer exists, or cannot be reached.
 */
export async function fetchConversationAttachment(
  db: Db,
  tenantId: string,
  conversationId: string,
  messageId: string,
  attachmentId: string,
  opts: { range?: string } = {},
  deps: { fetchImpl?: typeof fetch; isPublicHost?: (host: string) => Promise<boolean> } = {},
): Promise<AttachmentStream | null> {
  const attachment = await findAttachment(db, tenantId, conversationId, messageId, attachmentId);
  const url = attachment ? await getConversationAttachmentUrl(db, tenantId, conversationId, messageId, attachmentId) : null;
  if (!attachment || !url) return null;
  const target = new URL(url);
  // The provider address was validated when it was configured; it is checked again against what it resolves to now.
  if (!validateWebhookUrl(target.origin, { allowInsecure: webhookAllowInsecure() }).ok) return null;
  if (!webhookAllowInsecure() && !(await (deps.isPublicHost ?? resolvesToPublicAddresses)(target.hostname))) return null;
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      headers: { accept: "*/*", "ngrok-skip-browser-warning": "1", ...(opts.range && /^bytes=\d*-\d*$/.test(opts.range) ? { range: opts.range } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return null;
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const upstreamType = (res.headers.get("content-type") ?? attachment.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const inline = INLINE_MEDIA.test(upstreamType);
  const headers: Record<string, string> = {
    "content-type": inline ? upstreamType : "application/octet-stream",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "accept-ranges": res.headers.get("accept-ranges") ?? "bytes",
  };
  for (const h of ["content-length", "content-range"]) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  if (!inline) headers["content-disposition"] = `attachment; filename="${(attachment.fileName ?? "file").replace(/[^A-Za-z0-9._ -]/g, "_")}"`;
  return { status: res.status as 200 | 206, headers, body: res.body };
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

export interface ConversationSendDeps {
  /** Replaceable in tests. */
  adapterFor?: (provider: string) => MessagingProviderAdapter | null;
}

const SERVICE_WINDOW_MS = 24 * 3600_000;
/** WhatsApp lets a business reply freely only for 24 hours after the patient's last message; after that only an approved template. */
const windowClosed = (c: { lastPatientInboundAt: Date | null }, now: Date) => !c.lastPatientInboundAt || now.getTime() - c.lastPatientInboundAt.getTime() > SERVICE_WINDOW_MS;

type Delivery = { providerMessageId: string | null; deliveryStatus: "sent" | "failed" | null; reason: string | null };

/**
 * Hand a text to the conversation's provider. A conversation with no live provider stays local (deliveryStatus null, as before).
 * A provider that is selected but cannot send says why, in its own words, instead of a bare "failed".
 */
async function deliverText(db: Db, existing: typeof conversations.$inferSelect, body: string, deps: ConversationSendDeps): Promise<Delivery> {
  if (!existing.connectorId) return { providerMessageId: null, deliveryStatus: null, reason: null };
  const connector = await getConnectorById(db, existing.connectorId);
  const adapter = connector ? (deps.adapterFor ?? getMessagingAdapter)(connector.provider) : null;
  if (!connector || !adapter) return { providerMessageId: null, deliveryStatus: null, reason: null };
  const [patient] = await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, existing.patientId)).limit(1);
  const to = existing.externalThreadId ?? patient?.phone;
  const secrets = to ? await getConnectorSecrets(db, connector.id) : null;
  if (!to || !secrets) {
    // WhatsNexus is a real sender: not being able to send must be visible. Other providers keep their earlier behaviour.
    return connector.provider === "whatsnexus" ? { providerMessageId: null, deliveryStatus: "failed", reason: "PROVIDER_NOT_CONFIGURED: WhatsNexus credentials or the patient's number are missing" } : { providerMessageId: null, deliveryStatus: null, reason: null };
  }
  try {
    // mode must be stamped onto config exactly like campaign-sync.service.ts does for its adapter calls — without it,
    // config.mode is undefined, every adapter's fixture guard is skipped and a FIXTURE connector attempts a real call.
    const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase(), pulseosTenantId: existing.tenantId };
    // A reply must go out from the same hospital line the thread arrived on (for WhatsApp, providerRef IS the phone_number_id).
    if (existing.communicationEndpointId) {
      const [endpoint] = await db.select({ providerRef: communicationEndpoints.providerRef }).from(communicationEndpoints).where(eq(communicationEndpoints.id, existing.communicationEndpointId)).limit(1);
      if (endpoint) config.phoneNumberId = endpoint.providerRef;
    }
    const sent = await adapter.sendMessage(config, secrets, to, body);
    await touchConnectorSuccess(db, connector.id);
    return { providerMessageId: sent.providerMessageId, deliveryStatus: "sent", reason: null };
  } catch (err) {
    const reason = redactLogText((err as Error).message) ?? "send failed";
    // A refused template or a closed window is about this message, not the connection.
    const code = (err as { code?: string }).code ?? "";
    if (!code.startsWith("TEMPLATE_") && code !== "TEMPLATE_REQUIRED") await touchConnectorError(db, connector.id, reason);
    return { providerMessageId: null, deliveryStatus: "failed", reason };
  }
}

export async function sendMessage(db: Db, tenantId: string, conversationId: string, actorId: string, body: string, now: Date = new Date(), deps: ConversationSendDeps = {}): Promise<SendMessageResult | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  // Outside the 24-hour window a free-form text cannot be delivered: say so now, before anything is stored or sent.
  if (existing.connectorId && windowClosed(existing, now)) return { ok: false, reason: "template_required" };

  const out = await deliverText(db, existing, body, deps);
  await db.insert(messages).values({
    tenantId,
    conversationId,
    senderType: "staff",
    senderUserId: actorId,
    body,
    sentAt: now,
    connectorId: existing.connectorId,
    providerMessageId: out.providerMessageId,
    deliveryStatus: out.deliveryStatus,
  });
  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversationId));

  // Staff messages are part of the same conversation session as the patient's: one Timeline line for the
  // session, and the idle deadline is pushed out (even when delivery failed — the thread still moved).
  await recordConversationActivity(db, tenantId, conversationId, { at: now, sender: "staff" });

  return { ok: true, deliveryStatus: out.deliveryStatus as MessageDeliveryStatus | null, reason: out.reason };
}

/**
 * Send a failed message again, as the SAME message. Claimed first (failed → queued) so a double click can never send it twice;
 * only a staff text that failed is eligible — a delivered message is never "retried".
 */
export async function retryConversationMessage(db: Db, tenantId: string, conversationId: string, messageId: string, actorId: string, deps: ConversationSendDeps = {}, now: Date = new Date()): Promise<SendMessageResult | { ok: false; reason: string }> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  const [message] = await db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId))).limit(1);
  if (!message) return { ok: false, reason: "message_not_found" };
  const attachments = await db.select({ id: messageAttachments.id }).from(messageAttachments).where(eq(messageAttachments.messageId, message.id)).limit(1);
  if (message.senderType !== "staff" || !message.senderUserId || message.deliveryStatus !== "failed" || attachments.length > 0) return { ok: false, reason: "not_retryable" };
  if (existing.connectorId && windowClosed(existing, now)) return { ok: false, reason: "template_required" };

  const claimed = await db.update(messages).set({ deliveryStatus: "queued" }).where(and(eq(messages.id, message.id), eq(messages.deliveryStatus, "failed"))).returning({ id: messages.id });
  if (claimed.length === 0) return { ok: false, reason: "not_retryable" };

  const out = await deliverText(db, existing, message.body, deps);
  await db.update(messages).set({ deliveryStatus: out.deliveryStatus ?? "failed", providerMessageId: out.providerMessageId }).where(eq(messages.id, message.id));
  void actorId;
  return { ok: true, deliveryStatus: (out.deliveryStatus ?? "failed") as MessageDeliveryStatus, reason: out.reason };
}

export type SendMediaResult = { ok: true } | { ok: false; reason: string; detail?: string };

/**
 * Send a photo, video, document or voice note to the patient. Checked against the same rules the browser applies, then handed
 * to the provider. A file the provider refuses says why and is not stored; only a credential/transport failure counts against
 * the connection. If the provider accepted it, it is reported as sent even if recording it here hiccups.
 */
export async function sendMediaMessage(
  db: Db,
  tenantId: string,
  conversationId: string,
  actorId: string,
  media: { kind: MessageAttachmentKind; fileName: string; mimeType: string; base64: string; caption: string },
  deps: ConversationSendDeps = {},
  now: Date = new Date(),
): Promise<SendMediaResult> {
  const existing = await findConversation(db, tenantId, conversationId);
  if (!existing) return { ok: false, reason: "conversation_not_found" };
  if (!existing.connectorId || windowClosed(existing, now)) return { ok: false, reason: "template_required" };
  const sizeBytes = Buffer.byteLength(media.base64, "base64");
  const check = checkMediaFile({ kind: media.kind, mimeType: media.mimeType, fileName: media.fileName, sizeBytes });
  if (!check.ok) return { ok: false, reason: check.reason, detail: check.message };

  const connector = await getConnectorById(db, existing.connectorId);
  const adapter = connector ? (deps.adapterFor ?? getMessagingAdapter)(connector.provider) : null;
  const [patient] = await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, existing.patientId)).limit(1);
  const to = existing.externalThreadId ?? patient?.phone;
  const secrets = connector && to ? await getConnectorSecrets(db, connector.id) : null;
  if (!connector || !adapter?.sendMedia || !to || !secrets) return { ok: false, reason: "media_not_supported" };

  let providerMessageId: string;
  try {
    const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown>) ?? {}), mode: connector.mode.toLowerCase(), pulseosTenantId: tenantId };
    providerMessageId = (await adapter.sendMedia(config, secrets, to, { ...media, idempotencyKey: crypto.randomUUID() })).providerMessageId;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "TEMPLATE_REQUIRED") return { ok: false, reason: "template_required" };
    const detail = redactLogText((err as Error).message) ?? "send failed";
    // A file the provider refused (INVALID_REQUEST) is about this file, not the connection.
    if (code !== "INVALID_REQUEST" && !code.startsWith("TEMPLATE_")) await touchConnectorError(db, connector.id, detail);
    return { ok: false, reason: "send_failed", detail };
  }
  try {
    const [message] = await db.insert(messages).values({ tenantId, conversationId, senderType: "staff", senderUserId: actorId, body: media.caption, sentAt: now, connectorId: connector.id, providerMessageId, deliveryStatus: "sent" }).returning({ id: messages.id });
    await db.insert(messageAttachments).values({ tenantId, messageId: message!.id, kind: media.kind, providerMediaId: providerMessageId, fileName: media.fileName, mimeType: media.mimeType.split(";")[0]!.trim(), sizeBytes });
    await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversationId));
    await recordConversationActivity(db, tenantId, conversationId, { at: now, sender: "staff" });
    await touchConnectorSuccess(db, connector.id);
  } catch (err) {
    // The patient has the file; failing the request now would invite a second send.
    console.error("media was sent but could not be recorded", conversationId, err);
  }
  return { ok: true };
}

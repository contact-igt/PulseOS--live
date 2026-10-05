import { tenantCapabilityMap } from "../../capability/capability.service.js";
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import { conversationSummaries, conversations, messages, patients, tenantSettings, timelineEvents } from "../../../db/schema.js";
import { tenantTimezone } from "../../../lib/hospital-time.js";
import { CONVERSATION_IDLE_RANGE, type ConversationSettings, type ConversationSummaryState, type ConversationSummaryVm, type SummaryMode } from "@pulseos/types";
import { clampIdleMinutes, dueAfter, sessionTitle } from "./session-time.js";
import { MAX_FIELD, MAX_QUESTIONS, type ConversationSummarizer, type SummarizerMessage, type SummaryDraft } from "./summarizer.js";

// Conversation sessions. The deadline for "idle enough to summarize" is the conversations.summary_due_at
// column — the only source of truth. Nothing here relies on an in-memory timer: a runner (see jobs/runner.ts)
// claims due conversations with a conditional UPDATE, so a restart loses nothing and two workers never
// summarize the same session twice. Raw messages are authoritative and are never changed or deleted.

export const SESSION_EVENT = "whatsapp_conversation";
const STALE_CLAIM_MS = 10 * 60_000;
export const MAX_SUMMARY_ATTEMPTS = 5;
const BATCH = 50;

type Sender = "patient" | "staff" | "ai" | "system";

// --- settings ---------------------------------------------------------------

export async function getConversationSettings(db: Db, tenantId: string): Promise<ConversationSettings> {
  const [row] = await db.select({ m: tenantSettings.conversationIdleMinutes }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return { idleMinutes: clampIdleMinutes(row?.m) };
}

export async function updateConversationSettings(db: Db, tenantId: string, idleMinutes: number): Promise<{ ok: true; settings: ConversationSettings } | { ok: false; reason: string }> {
  if (!Number.isInteger(idleMinutes) || idleMinutes < CONVERSATION_IDLE_RANGE.min || idleMinutes > CONVERSATION_IDLE_RANGE.max) return { ok: false, reason: "idle_minutes_out_of_range" };
  await db
    .insert(tenantSettings)
    .values({ tenantId, conversationIdleMinutes: idleMinutes })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { conversationIdleMinutes: idleMinutes, updatedAt: new Date() } });
  return { ok: true, settings: { idleMinutes } };
}

// --- recording activity -----------------------------------------------------

/**
 * Call after every message is stored (patient inbound or staff / AI outbound). Pushes the summary deadline out to
 * "this message + the idle window" (debounce), remembers the last patient message (the WhatsApp service window)
 * and keeps the one concise Timeline line for the current session up to date.
 */
export async function recordConversationActivity(db: Db, tenantId: string, conversationId: string, activity: { at: Date; sender: Sender }): Promise<void> {
  // Conversation Intelligence off: no summary deadline, no session line, no summarizer cost for this hospital.
  if (!(await tenantCapabilityMap(db, tenantId)).CONVERSATION_INTELLIGENCE) return;
  const { idleMinutes } = await getConversationSettings(db, tenantId);
  const due = dueAfter(activity.at, idleMinutes).toISOString();
  const at = activity.at.toISOString();
  await db
    .update(conversations)
    .set({
      // Never earlier than a deadline already set (a late-arriving older message must not shorten the wait).
      summaryDueAt: sql`greatest(coalesce(${conversations.summaryDueAt}, ${due}::timestamptz), ${due}::timestamptz)`,
      summaryAttempts: 0,
      summaryError: null,
      ...(activity.sender === "patient" ? { lastPatientInboundAt: sql`greatest(coalesce(${conversations.lastPatientInboundAt}, ${at}::timestamptz), ${at}::timestamptz)` } : {}),
    })
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  await syncSessionTimelineEvent(db, tenantId, conversationId);
}

/** The latest summary of a conversation, with the message it ended on. */
async function lastSummaryOf(db: Db, conversationId: string) {
  const [row] = await db.select().from(conversationSummaries).where(eq(conversationSummaries.conversationId, conversationId)).orderBy(desc(conversationSummaries.segmentNo)).limit(1);
  return row ?? null;
}

/** Messages not yet covered by a summary, in (sentAt, id) order. */
async function unsummarizedMessages(db: Db, conversationId: string, last: { lastMessageAt: Date; lastMessageId: string } | null) {
  return db
    .select({ id: messages.id, senderType: messages.senderType, body: messages.body, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), last ? sql`(${messages.sentAt}, ${messages.id}) > (${last.lastMessageAt.toISOString()}::timestamptz, ${last.lastMessageId}::uuid)` : undefined))
    .orderBy(asc(messages.sentAt), asc(messages.id));
}

/** One Timeline line per conversation session: "WhatsApp conversation · 12 messages · 3:42 pm – 4:11 pm". */
export async function syncSessionTimelineEvent(db: Db, tenantId: string, conversationId: string): Promise<void> {
  const [conv] = await db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  if (!conv) return;
  const last = await lastSummaryOf(db, conversationId);
  const open = await unsummarizedMessages(db, conversationId, last);
  if (open.length === 0) return;
  const tz = await tenantTimezone(db, tenantId);
  const first = open[0]!;
  const final = open[open.length - 1]!;
  const title = sessionTitle(open.length, first.sentAt, final.sentAt, tz);
  const metadata = { messageCount: open.length, firstMessageId: first.id, lastMessageId: final.id };

  const [existing] = await db
    .select({ id: timelineEvents.id })
    .from(timelineEvents)
    .where(and(eq(timelineEvents.tenantId, tenantId), eq(timelineEvents.eventType, SESSION_EVENT), eq(timelineEvents.relatedEntityId, conversationId), sql`${timelineEvents.metadata}->>'summaryId' is null`))
    .orderBy(desc(timelineEvents.occurredAt))
    .limit(1);
  if (existing) {
    await db.update(timelineEvents).set({ title, metadata, journeyId: conv.journeyId }).where(eq(timelineEvents.id, existing.id));
  } else {
    await db.insert(timelineEvents).values({
      tenantId, patientId: conv.patientId, journeyId: conv.journeyId, actorType: "system", eventType: SESSION_EVENT, sourceChannel: "whatsapp", channel: "WHATSAPP",
      title, relatedEntityType: "conversation", relatedEntityId: conversationId, metadata, occurredAt: first.sentAt,
    });
  }
}

// --- summarizing ------------------------------------------------------------

const clip = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? (t.length > MAX_FIELD ? `${t.slice(0, MAX_FIELD - 1).trimEnd()}…` : t) : null;
};
const sanitize = (d: SummaryDraft): SummaryDraft => ({
  summary: clip(d.summary) ?? "Conversation",
  patientIntent: clip(d.patientIntent),
  serviceInterest: clip(d.serviceInterest),
  questions: (d.questions ?? []).map((q) => clip(q)).filter((q): q is string => !!q).slice(0, MAX_QUESTIONS),
  outcome: clip(d.outcome),
  promisedAction: clip(d.promisedAction),
  nextAction: clip(d.nextAction),
});

type ConvRow = typeof conversations.$inferSelect;
type SummaryRow = typeof conversationSummaries.$inferSelect;

export function toSummaryVm(r: SummaryRow): ConversationSummaryVm {
  return {
    id: r.id,
    conversationId: r.conversationId,
    patientId: r.patientId,
    journeyId: r.journeyId,
    segmentNo: r.segmentNo,
    messageCount: r.messageCount,
    firstMessageAt: r.firstMessageAt.toISOString(),
    lastMessageAt: r.lastMessageAt.toISOString(),
    summary: r.summary,
    patientIntent: r.patientIntent,
    serviceInterest: r.serviceInterest,
    questions: ((r.questions as unknown[]) ?? []).filter((q): q is string => typeof q === "string"),
    outcome: r.outcome,
    promisedAction: r.promisedAction,
    nextAction: r.nextAction,
    generatedAt: r.generatedAt.toISOString(),
    provider: r.provider,
    mode: r.mode as SummaryMode,
  };
}

type SummarizeOutcome = { kind: "summary"; row: SummaryRow } | { kind: "nothing_new" };

/** Summarize the unsummarized messages of a conversation the caller has already claimed. Throws if the summarizer fails. */
async function summarizeClaimed(db: Db, conv: ConvRow, now: Date, summarizer: ConversationSummarizer): Promise<SummarizeOutcome> {
  const last = await lastSummaryOf(db, conv.id);
  const open = await unsummarizedMessages(db, conv.id, last);
  if (open.length === 0) {
    await releaseClaim(db, conv.id, { clearDue: true });
    return { kind: "nothing_new" };
  }
  const input: SummarizerMessage[] = open.map((m) => ({ sender: m.senderType, body: m.body, at: m.sentAt }));
  const draft = sanitize(await summarizer.summarize(input));
  const first = open[0]!;
  const final = open[open.length - 1]!;

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(conversationSummaries)
      .values({
        tenantId: conv.tenantId, conversationId: conv.id, patientId: conv.patientId, journeyId: conv.journeyId,
        segmentNo: (last?.segmentNo ?? 0) + 1, firstMessageId: first.id, lastMessageId: final.id, firstMessageAt: first.sentAt, lastMessageAt: final.sentAt,
        messageCount: open.length, summary: draft.summary, patientIntent: draft.patientIntent, serviceInterest: draft.serviceInterest, questions: draft.questions,
        outcome: draft.outcome, promisedAction: draft.promisedAction, nextAction: draft.nextAction, generatedAt: now, provider: summarizer.provider, mode: summarizer.mode,
      })
      .onConflictDoNothing({ target: [conversationSummaries.conversationId, conversationSummaries.lastMessageId] })
      .returning();
    const summary = inserted ?? (await tx.select().from(conversationSummaries).where(and(eq(conversationSummaries.conversationId, conv.id), eq(conversationSummaries.lastMessageId, final.id))))[0]!;
    // The session's Timeline line now carries the summary text.
    await tx
      .update(timelineEvents)
      .set({ description: summary.summary, metadata: { messageCount: open.length, firstMessageId: first.id, lastMessageId: final.id, summaryId: summary.id }, journeyId: conv.journeyId })
      .where(and(eq(timelineEvents.tenantId, conv.tenantId), eq(timelineEvents.eventType, SESSION_EVENT), eq(timelineEvents.relatedEntityId, conv.id), sql`${timelineEvents.metadata}->>'summaryId' is null`));
    // Done — unless newer messages arrived while this ran, in which case their (later) deadline stays.
    await tx
      .update(conversations)
      .set({
        summaryState: "idle", summaryClaimedAt: null, summaryAttempts: 0, summaryError: null,
        summaryDueAt: sql`case when (select max(${messages.sentAt}) from ${messages} where ${messages.conversationId} = ${conv.id}) > ${final.sentAt.toISOString()}::timestamptz then ${conversations.summaryDueAt} else null end`,
      })
      .where(eq(conversations.id, conv.id));
    return summary;
  });
  return { kind: "summary", row };
}

async function releaseClaim(db: Db, conversationId: string, opts: { clearDue?: boolean } = {}) {
  await db.update(conversations).set({ summaryState: "idle", summaryClaimedAt: null, ...(opts.clearDue ? { summaryDueAt: null } : {}) }).where(eq(conversations.id, conversationId));
}

async function recordFailure(db: Db, conv: ConvRow, now: Date, error: unknown) {
  const attempts = conv.summaryAttempts + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  const gaveUp = attempts >= MAX_SUMMARY_ATTEMPTS;
  await db
    .update(conversations)
    .set({
      summaryState: "idle", summaryClaimedAt: null, summaryAttempts: attempts, summaryError: message,
      // Back off (5, 10, 15... minutes, at most an hour); after the last attempt stop retrying until a new message arrives.
      summaryDueAt: gaveUp ? null : new Date(now.getTime() + Math.min(attempts * 5, 60) * 60_000),
    })
    .where(eq(conversations.id, conv.id));
}

/** Claim a conversation: only one worker can hold it; a claim older than 10 minutes is considered dead. */
async function claim(db: Db, conversationId: string, now: Date, opts: { requireDue: boolean }): Promise<ConvRow | null> {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const [row] = await db
    .update(conversations)
    .set({ summaryState: "processing", summaryClaimedAt: now })
    .where(
      and(
        eq(conversations.id, conversationId),
        opts.requireDue ? and(isNotNull(conversations.summaryDueAt), lte(conversations.summaryDueAt, now)) : undefined,
        or(eq(conversations.summaryState, "idle"), sql`${conversations.summaryClaimedAt} < ${staleBefore}::timestamptz`),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The due-job: summarize every conversation whose idle deadline has passed. Safe to run from several workers
 * and to run repeatedly; `now` is explicit so tests control the clock.
 */
export async function processDueConversationSummaries(db: Db, now: Date, summarizer: ConversationSummarizer, opts: { onlyConversationIds?: string[]; limit?: number } = {}): Promise<{ processed: number; failed: number }> {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const due = await db
    .select({ id: conversations.id, tenantId: conversations.tenantId })
    .from(conversations)
    .where(
      and(
        isNotNull(conversations.summaryDueAt),
        lte(conversations.summaryDueAt, now),
        or(eq(conversations.summaryState, "idle"), sql`${conversations.summaryClaimedAt} < ${staleBefore}::timestamptz`),
        opts.onlyConversationIds ? inArray(conversations.id, opts.onlyConversationIds) : undefined,
      ),
    )
    .orderBy(asc(conversations.summaryDueAt))
    .limit(opts.limit ?? BATCH);

  let processed = 0;
  let failed = 0;
  const capByTenant = new Map<string, boolean>();
  for (const { id, tenantId } of due) {
    if (!capByTenant.has(tenantId)) capByTenant.set(tenantId, (await tenantCapabilityMap(db, tenantId)).CONVERSATION_INTELLIGENCE);
    if (!capByTenant.get(tenantId)) {
      // Switched off since the deadline was set: drop the deadline instead of summarizing.
      await db.update(conversations).set({ summaryDueAt: null }).where(eq(conversations.id, id));
      continue;
    }
    const conv = await claim(db, id, now, { requireDue: true });
    if (!conv) continue; // another worker took it
    try {
      const out = await summarizeClaimed(db, conv, now, summarizer);
      if (out.kind === "summary") processed++;
    } catch (err) {
      failed++;
      await recordFailure(db, conv, now, err);
    }
  }
  return { processed, failed };
}

/** "Refresh summary": summarize the new messages now (ignoring the idle deadline). */
export async function refreshConversationSummary(
  db: Db,
  tenantId: string,
  conversationId: string,
  now: Date,
  summarizer: ConversationSummarizer,
): Promise<{ ok: true; summary: ConversationSummaryVm } | { ok: false; reason: "conversation_not_found" | "nothing_new" | "busy" | "summarizer_failed" }> {
  const [exists] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  if (!exists) return { ok: false, reason: "conversation_not_found" };
  const conv = await claim(db, conversationId, now, { requireDue: false });
  if (!conv) return { ok: false, reason: "busy" };
  try {
    const out = await summarizeClaimed(db, conv, now, summarizer);
    return out.kind === "summary" ? { ok: true, summary: toSummaryVm(out.row) } : { ok: false, reason: "nothing_new" };
  } catch {
    await releaseClaim(db, conversationId);
    return { ok: false, reason: "summarizer_failed" };
  }
}

// --- reads ------------------------------------------------------------------

export async function listConversationSummaries(db: Db, tenantId: string, conversationId: string): Promise<ConversationSummaryVm[] | null> {
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)));
  if (!conv) return null;
  const rows = await db.select().from(conversationSummaries).where(and(eq(conversationSummaries.tenantId, tenantId), eq(conversationSummaries.conversationId, conversationId))).orderBy(asc(conversationSummaries.segmentNo));
  return rows.map(toSummaryVm);
}

/** Summaries for one patient (optionally one Journey) — only if the patient belongs to the caller's hospital. */
export async function listPatientSummaries(db: Db, tenantId: string, patientId: string, journeyId?: string): Promise<ConversationSummaryVm[] | null> {
  const [p] = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.id, patientId), eq(patients.tenantId, tenantId)));
  if (!p) return null;
  const rows = await db
    .select()
    .from(conversationSummaries)
    .where(and(eq(conversationSummaries.tenantId, tenantId), eq(conversationSummaries.patientId, patientId), journeyId ? eq(conversationSummaries.journeyId, journeyId) : undefined))
    .orderBy(asc(conversationSummaries.firstMessageAt));
  return rows.map(toSummaryVm);
}

export async function getConversationSummaryState(db: Db, conv: Pick<ConvRow, "id" | "summaryDueAt" | "summaryState" | "summaryError" | "summaryAttempts">): Promise<ConversationSummaryState> {
  const all = await db.select().from(conversationSummaries).where(eq(conversationSummaries.conversationId, conv.id)).orderBy(desc(conversationSummaries.segmentNo));
  const latest = all[0] ?? null;
  const open = await unsummarizedMessages(db, conv.id, latest ? { lastMessageAt: latest.lastMessageAt, lastMessageId: latest.lastMessageId } : null);
  const unsummarizedCount = open.length;
  const failed = unsummarizedCount > 0 && conv.summaryDueAt === null && conv.summaryAttempts >= MAX_SUMMARY_ATTEMPTS && !!conv.summaryError;
  return {
    latest: latest ? toSummaryVm(latest) : null,
    segments: all.length,
    pending: unsummarizedCount > 0 && !failed,
    dueAt: conv.summaryDueAt ? conv.summaryDueAt.toISOString() : null,
    failed,
    unsummarizedCount,
  };
}

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { callIntelligence, calls, connectors } from "../../db/schema.js";
import type { ConnectorMode, CallTranscriptVm } from "@pulseos/types";
import type { ConversationSummarizer, SummarizerMessage } from "../conversation/summary/summarizer.js";
import { getTranscriber, type Transcriber } from "./transcriber.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Give up after this many failed attempts at one stage. The call itself is never affected. */
export const MAX_ATTEMPTS = 3;
const BACKOFF_MINUTES = [1, 5];
/** A claim older than this is a worker that died mid-job: the row is picked up again. */
const STALE_CLAIM_MINUTES = 5;

/**
 * Create the intelligence row for a call, once. Called inside the call-ingest transaction.
 *  - a transcript already supplied by the provider is stored as-is (mode PROVIDER), only the summary remains;
 *  - a recording with a transcriber available is queued;
 *  - a recording with no transcriber is honestly NOT_CONFIGURED (the call and recording stay fully usable);
 *  - no recording and no transcript: nothing to derive, no row.
 */
export async function ensureCallIntelligence(
  db: Db | Tx,
  call: { id: string; tenantId: string; hasRecording: boolean },
  ctx: { connectorMode: ConnectorMode | null; providerTranscript?: string | null },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const provided = ctx.providerTranscript?.trim() || null;
  if (!provided && !call.hasRecording) return;
  const base = { tenantId: call.tenantId, callId: call.id };
  const values = provided
    ? { ...base, transcript: provided, transcriptStatus: "COMPLETED" as const, transcriptMode: "PROVIDER", transcriptProvider: "provider", summaryStatus: "PENDING" as const }
    : getTranscriber(ctx.connectorMode, env)
      ? { ...base, transcriptStatus: "PENDING" as const, summaryStatus: "PENDING" as const }
      : { ...base, transcriptStatus: "NOT_CONFIGURED" as const, summaryStatus: "NOT_CONFIGURED" as const };
  await db.insert(callIntelligence).values(values).onConflictDoNothing({ target: callIntelligence.callId });
}

/** "Patient: …" / "Hospital: …" lines → messages. A transcript with no speaker labels is one unattributed block. */
export function transcriptToMessages(text: string, at: Date): SummarizerMessage[] {
  const out: SummarizerMessage[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(patient|caller|customer|hospital|staff|agent|receptionist)\s*:\s*(.*)$/i.exec(line);
    if (m) out.push({ sender: /^(patient|caller|customer)$/i.test(m[1]!) ? "patient" : "staff", body: m[2]!, at });
    else if (out.length > 0) out[out.length - 1]!.body += ` ${line}`;
    else out.push({ sender: "system", body: line, at });
  }
  return out.filter((m) => m.body.trim());
}

export interface IntelligenceDeps {
  transcriberFor: (mode: ConnectorMode | null) => Transcriber | null;
  summarizer: ConversationSummarizer;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200);
const backoff = (attempts: number, now: Date) => new Date(now.getTime() + (BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 5) * 60_000);

type Claimed = { id: string; call_id: string; tenant_id: string; attempts: number };

/** Atomically claim due rows for one stage; `FOR UPDATE SKIP LOCKED` makes concurrent workers safe. */
async function claim(db: Db, stage: "transcript" | "summary", now: Date, limit: number, onlyCallIds?: string[]): Promise<Claimed[]> {
  const col = sql.raw(stage === "transcript" ? "transcript_status" : "summary_status");
  const gate = stage === "summary" ? sql`and transcript_status = 'COMPLETED'` : sql``;
  const only = onlyCallIds?.length ? sql`and call_id in (${sql.join(onlyCallIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const stale = new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000);
  const rows = await db.execute(sql`
    update call_intelligence set ${col} = 'PROCESSING', claimed_at = ${now.toISOString()}::timestamptz
    where id in (
      select id from call_intelligence
      where ((${col} = 'PENDING' and next_attempt_at <= ${now.toISOString()}::timestamptz) or (${col} = 'PROCESSING' and claimed_at < ${stale.toISOString()}::timestamptz)) ${gate} ${only}
      order by next_attempt_at limit ${limit} for update skip locked)
    returning id, call_id, tenant_id, attempts`);
  return [...rows] as unknown as Claimed[];
}

/**
 * The durable job: transcribe due recordings, then summarize due transcripts. Idempotent and restart-safe (the
 * schedule and the claim live in the database). A failure at either stage is recorded on that stage only and
 * retried with backoff; after MAX_ATTEMPTS it is FAILED — and the call, its recording and staff feedback are untouched.
 */
export async function processDueCallIntelligence(db: Db, now: Date, deps: IntelligenceDeps, opts: { onlyCallIds?: string[]; limit?: number } = {}): Promise<{ transcribed: number; summarized: number; failed: number }> {
  const limit = opts.limit ?? 10;
  let transcribed = 0;
  let summarized = 0;
  let failed = 0;

  for (const row of await claim(db, "transcript", now, limit, opts.onlyCallIds)) {
    try {
      const [call] = await db
        .select({ recordingUrl: calls.recordingUrl, metadata: calls.metadata, mode: connectors.mode })
        .from(calls)
        .leftJoin(connectors, eq(calls.connectorId, connectors.id))
        .where(and(eq(calls.id, row.call_id), eq(calls.tenantId, row.tenant_id)))
        .limit(1);
      const transcriber = deps.transcriberFor(call?.mode ?? null);
      if (!call || !call.recordingUrl || !transcriber) {
        await db.update(callIntelligence).set({ transcriptStatus: "NOT_CONFIGURED", summaryStatus: "NOT_CONFIGURED", claimedAt: null }).where(eq(callIntelligence.id, row.id));
        continue;
      }
      const text = await transcriber.transcribe({ callId: row.call_id, recordingRef: call.recordingUrl, metadata: (call.metadata as Record<string, unknown> | null) ?? {} });
      if (!text) {
        await db.update(callIntelligence).set({ transcriptStatus: "NOT_CONFIGURED", summaryStatus: "NOT_CONFIGURED", claimedAt: null }).where(eq(callIntelligence.id, row.id));
        continue;
      }
      await db.update(callIntelligence).set({ transcript: text, transcriptStatus: "COMPLETED", transcriptProvider: transcriber.provider, transcriptMode: transcriber.mode, claimedAt: null, error: null }).where(eq(callIntelligence.id, row.id));
      transcribed++;
    } catch (err) {
      failed++;
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db
        .update(callIntelligence)
        .set({ attempts, error: errorText(err), claimedAt: null, transcriptStatus: giveUp ? "FAILED" : "PENDING", ...(giveUp ? { summaryStatus: "FAILED" as const } : { nextAttemptAt: backoff(attempts, now) }) })
        .where(eq(callIntelligence.id, row.id));
    }
  }

  for (const row of await claim(db, "summary", now, limit, opts.onlyCallIds)) {
    try {
      const [intel] = await db.select({ transcript: callIntelligence.transcript }).from(callIntelligence).where(eq(callIntelligence.id, row.id)).limit(1);
      const messages = transcriptToMessages(intel?.transcript ?? "", now);
      if (messages.length === 0) throw new Error("empty transcript");
      const draft = await deps.summarizer.summarize(messages, { medium: "call" });
      await db
        .update(callIntelligence)
        .set({
          summary: draft.summary,
          summaryDetails: { patientIntent: draft.patientIntent, serviceInterest: draft.serviceInterest, questions: draft.questions, agreedAction: draft.promisedAction, nextAction: draft.nextAction },
          summaryStatus: "COMPLETED",
          summaryProvider: deps.summarizer.provider,
          summaryMode: deps.summarizer.mode,
          generatedAt: now,
          claimedAt: null,
          error: null,
        })
        .where(eq(callIntelligence.id, row.id));
      summarized++;
    } catch (err) {
      failed++;
      const attempts = row.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db
        .update(callIntelligence)
        .set({ attempts, error: errorText(err), claimedAt: null, summaryStatus: giveUp ? "FAILED" : "PENDING", ...(giveUp ? {} : { nextAttemptAt: backoff(attempts, now) }) })
        .where(eq(callIntelligence.id, row.id));
    }
  }
  return { transcribed, summarized, failed };
}

/** Put a FAILED stage back in the queue. "not_found" is a call that is not in this hospital; "nothing_to_retry" a call with nothing failed. */
export async function retryCallIntelligence(db: Db, tenantId: string, callId: string, now: Date = new Date()): Promise<"queued" | "nothing_to_retry" | "not_found"> {
  const [call] = await db.select({ id: calls.id }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId))).limit(1);
  if (!call) return "not_found";
  const [row] = await db.select().from(callIntelligence).where(eq(callIntelligence.callId, callId)).limit(1);
  if (!row || (row.transcriptStatus !== "FAILED" && row.summaryStatus !== "FAILED")) return "nothing_to_retry";
  const transcriptFailed = row.transcriptStatus === "FAILED";
  await db
    .update(callIntelligence)
    .set({ attempts: 0, error: null, nextAttemptAt: now, claimedAt: null, ...(transcriptFailed ? { transcriptStatus: "PENDING" as const, summaryStatus: "PENDING" as const } : { summaryStatus: "PENDING" as const }) })
    .where(eq(callIntelligence.id, row.id));
  return "queued";
}

export async function getCallTranscript(db: Db, tenantId: string, callId: string): Promise<CallTranscriptVm | null> {
  const [call] = await db.select({ id: calls.id }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.id, callId))).limit(1);
  if (!call) return null;
  const [row] = await db.select().from(callIntelligence).where(eq(callIntelligence.callId, callId)).limit(1);
  if (!row) return { status: "NOT_CONFIGURED", mode: null, text: null };
  return { status: row.transcriptStatus, mode: row.transcriptMode === "PROVIDER" ? "PROVIDER" : row.transcriptMode === "FIXTURE" ? "FIXTURE" : null, text: row.transcriptStatus === "COMPLETED" ? row.transcript : null };
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectors, conversationSummaries, conversations, messages, patients, tenants, timelineEvents } from "../db/schema.js";
import { processInboundWhatsAppMessage } from "../domain/connector/whatsapp-webhook.service.js";
import { sendMessage } from "../domain/conversation/conversation.service.js";
import { processDueConversationSummaries } from "../domain/conversation/summary/conversation-session.service.js";
import { FixtureSummarizer } from "../domain/conversation/summary/fixture-summarizer.js";
import type { ConversationSummarizer } from "../domain/conversation/summary/summarizer.js";
import type { FastifyInstance } from "fastify";
import type { ConversationDetail, ConversationSummaryVm, SessionUser } from "@pulseos/types";

// Conversation sessions: a summary is made once a conversation has been idle for the tenant window (default
// 7 minutes), never per message; every message pushes the deadline out; the deadline lives in the database
// (so it survives a restart and never runs twice); summaries are derived, patient-scoped data and the raw
// thread is never touched. All times below are explicit instants — the clock is controlled.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const T0 = new Date("2026-03-10T09:00:00Z");
const min = (base: Date, m: number, s = 0) => new Date(base.getTime() + (m * 60 + s) * 1000);
const fixture = new FixtureSummarizer();

async function login(app: FastifyInstance, email: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return { cookie: res.cookies.find((c) => c.name === "pulseos_session")!.value, user: (res.json() as { user: SessionUser }).user };
}

describe.skipIf(!DEMO_PASSWORD)("conversation sessions and summaries (integration)", () => {
  let app: FastifyInstance;
  let admin: { cookie: string; user: SessionUser };
  let coordinator: { cookie: string; user: SessionUser };
  let gynAdmin: { cookie: string; user: SessionUser };
  let tenantId: string;
  let connectorId: string;
  const patientIds: string[] = [];

  const get = (who: { cookie: string }, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: who.cookie } });
  const send = (who: { cookie: string }, method: "POST" | "PATCH", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined, cookies: { pulseos_session: who.cookie } });
  const newPhone = () => `9199${String(Math.floor(10000000 + Math.random() * 89999999))}`;
  async function inbound(phone: string, body: string, at: Date) {
    const r = await processInboundWhatsAppMessage(db, tenantId, connectorId, { externalEventId: `wamid.${phone}.${at.getTime()}.${Math.random().toString(36).slice(2, 6)}`, externalThreadId: phone, fromPhone: phone, fromName: "Summary Patient", body, occurredAt: at, phoneNumberId: null });
    if (!patientIds.includes(r.patientId)) patientIds.push(r.patientId);
    return r;
  }
  const conv = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0]!;
  const summaries = async (id: string) => (await db.select().from(conversationSummaries).where(eq(conversationSummaries.conversationId, id)).orderBy(asc(conversationSummaries.segmentNo)));
  // `only` scopes a run to given conversations, so counts never depend on what other tests left due.
  const run = (now: Date, summarizer: ConversationSummarizer = fixture, only?: string[]) => processDueConversationSummaries(db, now, summarizer, { onlyConversationIds: only });
  const events = async (patientId: string, type: string) => (await db.select().from(timelineEvents).where(and(eq(timelineEvents.patientId, patientId), eq(timelineEvents.eventType, type)))).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await login(app, "eye.admin@pulseos.local");
    coordinator = await login(app, "eye.coordinator@pulseos.local");
    gynAdmin = await login(app, "gyn.admin@pulseos.local");
    tenantId = admin.user.tenantId;
    const [c] = await db.select({ id: connectors.id }).from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "whatsapp_meta_cloud")));
    connectorId = c!.id;
    // Start from the default window.
    await send(admin, "PATCH", "/settings/conversation", { idleMinutes: 7 });
  });

  afterAll(async () => {
    await send(admin, "PATCH", "/settings/conversation", { idleMinutes: 7 });
    if (patientIds.length) {
      const convs = await db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.patientId, patientIds));
      const cids = convs.map((c) => c.id);
      if (cids.length) {
        await db.delete(conversationSummaries).where(inArray(conversationSummaries.conversationId, cids));
        await db.delete(messages).where(inArray(messages.conversationId, cids));
      }
      await db.delete(timelineEvents).where(inArray(timelineEvents.patientId, patientIds));
      await db.delete(conversations).where(inArray(conversations.patientId, patientIds));
      await db.delete(patients).where(inArray(patients.id, patientIds));
    }
    await app.close();
    await queryClient.end();
  });

  it("does not summarize before the idle window passes, and does once it has (default 7 minutes)", async () => {
    const phone = newPhone();
    const { conversationId } = await inbound(phone, "Hello, I want to know about cataract surgery. Is Saturday available?", T0);
    expect((await conv(conversationId)).summaryDueAt?.toISOString()).toBe(min(T0, 7).toISOString());

    expect((await run(min(T0, 6, 59), fixture, [conversationId])).processed).toBe(0);
    expect(await summaries(conversationId)).toHaveLength(0);

    expect((await run(min(T0, 7), fixture, [conversationId])).processed).toBe(1);
    const [s] = await summaries(conversationId);
    expect(s).toMatchObject({ segmentNo: 1, messageCount: 1, mode: "FIXTURE", provider: "fixture" });
    expect(s!.summary.length).toBeGreaterThan(0);
    expect((await conv(conversationId)).summaryDueAt).toBeNull();
  });

  it("another patient or staff message resets the deadline; one summary covers the whole burst", async () => {
    const phone = newPhone();
    const { conversationId, patientId } = await inbound(phone, "Hi, do you do cataract surgery?", T0);
    await inbound(phone, "And what is the cost?", min(T0, 5));
    expect((await conv(conversationId)).summaryDueAt?.toISOString()).toBe(min(T0, 12).toISOString());
    expect(await run(min(T0, 11, 59), fixture, [conversationId])).toMatchObject({ processed: 0 });
    // A staff reply at +11 pushes it again: the deadline is "last message + window", whoever wrote it.
    await sendMessage(db, tenantId, conversationId, admin.user.id, "We will share the details shortly.", min(T0, 11));
    expect((await conv(conversationId)).summaryDueAt?.toISOString()).toBe(min(T0, 18).toISOString());
    expect((await run(min(T0, 17, 59), fixture, [conversationId])).processed).toBe(0);
    await run(min(T0, 18), fixture, [conversationId]);
    const all = await summaries(conversationId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ messageCount: 3 });
    expect(patientId).toBeTruthy();
  });

  it("is idempotent: running the job twice, or at the same moment from two workers, writes one summary", async () => {
    const { conversationId } = await inbound(newPhone(), "One message only", T0);
    const now = min(T0, 8);
    const [a, b] = await Promise.all([run(now, fixture, [conversationId]), run(now, fixture, [conversationId])]);
    expect(a.processed + b.processed).toBe(1); // exactly one worker won the claim
    expect((await run(now, fixture, [conversationId])).processed).toBe(0);
    expect(await summaries(conversationId)).toHaveLength(1);
  });

  it("survives a restart: the deadline is in the database, a stale claim is reclaimed, a fresh one is left alone", async () => {
    const { conversationId } = await inbound(newPhone(), "Waiting for my reply", T0);
    // A worker claimed it and died 11 minutes ago -> reclaimed. (No in-memory timer exists to lose.)
    await db.update(conversations).set({ summaryState: "processing", summaryClaimedAt: min(T0, -4) }).where(eq(conversations.id, conversationId));
    await run(min(T0, 7), fixture, [conversationId]);
    expect(await summaries(conversationId)).toHaveLength(1);

    const second = await inbound(newPhone(), "Another one", T0);
    await db.update(conversations).set({ summaryState: "processing", summaryClaimedAt: min(T0, 5) }).where(eq(conversations.id, second.conversationId));
    expect((await run(min(T0, 8), fixture, [second.conversationId])).processed).toBe(0); // claimed 3 minutes ago by a live worker
    expect(await summaries(second.conversationId)).toHaveLength(0);
  });

  it("new messages after a summary start the next session and get their own incremental summary", async () => {
    const phone = newPhone();
    const first = await inbound(phone, "Asking about LASIK costs?", T0);
    await run(min(T0, 7), fixture, [first.conversationId]);
    const later = min(T0, 60);
    await inbound(phone, "Hello again, can I book for Saturday?", later);
    await inbound(phone, "Morning slot please", min(later, 2));
    await run(min(later, 9), fixture, [first.conversationId]);
    const all = await summaries(first.conversationId);
    expect(all.map((s) => [s.segmentNo, s.messageCount])).toEqual([[1, 1], [2, 2]]);
    expect(all[1]!.firstMessageId).not.toBe(all[0]!.firstMessageId);
    expect(all[1]!.lastMessageAt.toISOString()).toBe(min(later, 2).toISOString());

    // Raw messages are untouched; there is one Timeline line per session and none per message.
    expect((await db.select().from(messages).where(eq(messages.conversationId, first.conversationId)))).toHaveLength(3);
    const sessions = await events(first.patientId, "whatsapp_conversation");
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.title).toContain("1 message");
    expect(sessions[1]!.title).toContain("2 messages");
    expect(sessions[1]!.description).toBeTruthy();
    expect(await events(first.patientId, "whatsapp_message")).toHaveLength(0);
  });

  it("the Timeline line says how its summary was made (FIXTURE here, never AI), and carries none before one exists", async () => {
    const { conversationId, patientId } = await inbound(newPhone(), "What are your Saturday timings?", T0);
    const timeline = async () => ((await get(coordinator, `/patients/${patientId}/timeline`)).json() as { eventType: string; summaryMode: string | null; description: string | null; relatedEntityId: string | null }[]).filter((e) => e.eventType === "whatsapp_conversation");
    expect(await timeline()).toMatchObject([{ summaryMode: null, description: null, relatedEntityId: conversationId }]);
    await run(min(T0, 8), fixture, [conversationId]);
    const after = await timeline();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ summaryMode: "FIXTURE" });
    expect(after[0]!.description).toBeTruthy();
  });

  it("when summarizing fails the raw thread is untouched, it retries later, and gives up quietly after repeated failures", async () => {
    const boom: ConversationSummarizer = { provider: "broken", mode: "AI", summarize: async () => { throw new Error("model unavailable"); } };
    const { conversationId } = await inbound(newPhone(), "Please call me back", T0);
    let now = min(T0, 7);
    expect(await run(now, boom, [conversationId])).toMatchObject({ processed: 0, failed: 1 });
    let c = await conv(conversationId);
    expect(c).toMatchObject({ summaryAttempts: 1, summaryState: "idle" });
    expect(c.summaryDueAt!.getTime()).toBeGreaterThan(now.getTime()); // backed off, not hammering
    expect(await summaries(conversationId)).toHaveLength(0);
    // The conversation is fully readable meanwhile, with a pending summary and no failure shown yet.
    const detail = (await get(admin, `/conversations/${conversationId}`)).json() as ConversationDetail;
    expect(detail.messages).toHaveLength(1);
    expect(detail.summary).toMatchObject({ latest: null, pending: true, failed: false, unsummarizedCount: 1 });

    for (let i = 2; i <= 5; i++) {
      now = new Date(c.summaryDueAt!.getTime());
      await run(now, boom, [conversationId]);
      c = await conv(conversationId);
    }
    expect(c).toMatchObject({ summaryAttempts: 5, summaryDueAt: null });
    expect(c.summaryError).toContain("model unavailable");
    const failed = (await get(admin, `/conversations/${conversationId}`)).json() as ConversationDetail;
    expect(failed.messages).toHaveLength(1);
    expect(failed.summary).toMatchObject({ pending: false, failed: true });

    // A new message starts fresh; this time the summarizer works.
    await inbound((await patientPhone(c.patientId)), "Still waiting", min(T0, 30));
    expect((await conv(conversationId))).toMatchObject({ summaryAttempts: 0, summaryError: null });
    await run(min(T0, 37), fixture, [conversationId]);
    expect(await summaries(conversationId)).toHaveLength(1);
  });

  async function patientPhone(id: string) {
    return (await db.select({ p: patients.phone }).from(patients).where(eq(patients.id, id)))[0]!.p.replace(/^\+/, "");
  }

  it("the admin-configurable idle window is kept to 5–10 minutes and applies to the next message", async () => {
    expect((await get(coordinator, "/settings/conversation")).json()).toEqual({ idleMinutes: 7 });
    expect((await send(coordinator, "PATCH", "/settings/conversation", { idleMinutes: 6 })).statusCode).toBe(403);
    for (const bad of [4, 11, 7.5, "7", null]) expect((await send(admin, "PATCH", "/settings/conversation", { idleMinutes: bad })).statusCode, String(bad)).toBe(400);
    expect((await send(admin, "PATCH", "/settings/conversation", { idleMinutes: 10 })).json()).toEqual({ idleMinutes: 10 });
    const { conversationId } = await inbound(newPhone(), "Hello", T0);
    expect((await conv(conversationId)).summaryDueAt?.toISOString()).toBe(min(T0, 10).toISOString());
    // Another hospital's setting is separate.
    expect((await get(gynAdmin, "/settings/conversation")).json()).toEqual({ idleMinutes: 7 });
    await send(admin, "PATCH", "/settings/conversation", { idleMinutes: 7 });
  });

  it("summaries are patient-scoped: another hospital, or another patient's id, gets nothing", async () => {
    const mine = await inbound(newPhone(), "My cataract question?", T0);
    const other = await inbound(newPhone(), "Someone else entirely", T0);
    await run(min(T0, 8), fixture, [mine.conversationId, other.conversationId]);
    const own = (await get(coordinator, `/conversations/${mine.conversationId}/summaries`)).json() as ConversationSummaryVm[];
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ patientId: mine.patientId, conversationId: mine.conversationId });

    expect((await get(gynAdmin, `/conversations/${mine.conversationId}/summaries`)).statusCode).toBe(404);
    expect((await get(gynAdmin, `/patients/${mine.patientId}/conversation-summaries`)).statusCode).toBe(404);
    const viaPatient = (await get(coordinator, `/patients/${mine.patientId}/conversation-summaries`)).json() as ConversationSummaryVm[];
    expect(viaPatient.map((s) => s.patientId)).toEqual([mine.patientId]);
    const otherOwn = (await get(coordinator, `/patients/${other.patientId}/conversation-summaries`)).json() as ConversationSummaryVm[];
    expect(otherOwn.map((s) => s.conversationId)).toEqual([other.conversationId]);
    expect((await get(coordinator, "/conversations/not-a-uuid/summaries")).statusCode).toBe(404);
  });

  it("'Refresh summary' summarizes new messages now, and says so when there is nothing new", async () => {
    const { conversationId } = await inbound(newPhone(), "Can someone call me today?", T0);
    const first = await send(admin, "POST", `/conversations/${conversationId}/summary/refresh`);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ segmentNo: 1, messageCount: 1, mode: "FIXTURE" });
    const again = await send(admin, "POST", `/conversations/${conversationId}/summary/refresh`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("nothing_new");
    expect((await send(gynAdmin, "POST", `/conversations/${conversationId}/summary/refresh`)).statusCode).toBe(404);
  });

  it("tracks the WhatsApp service window: last patient message + 24h; a staff reply does not extend it", async () => {
    const { conversationId } = await inbound(newPhone(), "Hi", T0);
    await sendMessage(db, tenantId, conversationId, admin.user.id, "Hello! How can we help?", min(T0, 3));
    expect((await conv(conversationId)).lastPatientInboundAt?.toISOString()).toBe(T0.toISOString());
    const detail = (await get(admin, `/conversations/${conversationId}`)).json() as ConversationDetail;
    expect(detail.serviceWindowExpiresAt).toBe(new Date(T0.getTime() + 24 * 3600_000).toISOString());
  });

  it("never reads another tenant's messages when summarizing (the input is this conversation's thread only)", async () => {
    const seen: string[][] = [];
    const spy: ConversationSummarizer = { provider: "spy", mode: "FIXTURE", summarize: async (m) => { seen.push(m.map((x) => x.body)); return fixture.summarize(m); } };
    const a = await inbound(newPhone(), "alpha-marker message", T0);
    const b = await inbound(newPhone(), "bravo-marker message", T0);
    await run(min(T0, 9), spy, [a.conversationId, b.conversationId]);
    const both = seen.filter((s) => s.some((x) => x.includes("alpha-marker") || x.includes("bravo-marker")));
    expect(both).toHaveLength(2);
    for (const thread of both) expect(thread.some((x) => x.includes("alpha-marker")) && thread.some((x) => x.includes("bravo-marker"))).toBe(false);
    expect(a.conversationId).not.toBe(b.conversationId);
    // And the tenant on the summaries matches the conversation's tenant.
    const rows = await summaries(a.conversationId);
    expect(rows.every((r) => r.tenantId === tenantId)).toBe(true);
    const [t] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId));
    expect(t).toBeTruthy();
  });
});

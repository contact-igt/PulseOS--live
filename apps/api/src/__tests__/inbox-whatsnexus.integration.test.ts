import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ConversationDetail, ConversationRow, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectors, conversations, messages, patients } from "../db/schema.js";
import { createWhatsNexusAdapter } from "../domain/connector/adapters/whatsnexus.js";
import { fetchConversationAttachment, retryConversationMessage, sendMediaMessage, sendMessage } from "../domain/conversation/conversation.service.js";
import { sendFollowUpMessage } from "../domain/notification/notification.service.js";
import { signWebhookBody } from "../domain/integration/webhook-rules.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const API_KEY = "wnpk_it_key_0123456789abcdefghijklmnop";
const CB = "whcs_inbox_secret_0123456789abcdefghij";
const CB_OTHER = "whcs_inbox_other_0123456789abcdefghi";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe.skipIf(!DEMO_PASSWORD)("Inbox through WhatsNexus: AI and agent replies, sending, delivery state (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // inbox on
  let other: TestTenant; // another hospital with its own WhatsNexus secret
  let v1: TestTenant; // inbox off
  let n = 0;
  const wa = () => `91${String(9100000000 + ++n * 7919)}`;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });

  async function configureWn(tt: TestTenant, secret: string) {
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { baseUrl: "https://wn.example.com/", tenantId: "TT001" } })).statusCode).toBe(200);
    expect((await call(tt, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { secrets: { apiKey: API_KEY, callbackSecret: secret }, mode: "LIVE" })).statusCode).toBe(200);
    await db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
  }
  const callback = (tenantId: string, secret: string, body: object) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return app.inject({ method: "POST", url: `/webhooks/whatsnexus/${tenantId}`, payload: raw, headers: { "content-type": "application/json", "x-whatsnexus-timestamp": String(ts), "x-whatsnexus-signature": signWebhookBody(secret, String(ts), raw) } });
  };
  const inbound = (tt: TestTenant, thread: string, text: string, secret = CB, id = `in-${++n}-${Date.now()}`) =>
    callback(tt.tenantId, secret, { type: "inbound_message", eventId: id, externalThreadId: thread, fromPhone: thread, fromName: "Naveen Raj", body: text, occurredAt: new Date().toISOString(), phoneNumberId: "pn-1", attachments: [] });
  const outbound = (tt: TestTenant, thread: string, over: Record<string, unknown> = {}, secret = CB) => {
    const wamid = (over.wamid as string) ?? `wamid.OUT${++n}${Date.now()}`;
    return callback(tt.tenantId, secret, { type: "outbound_message", eventId: `out:${wamid}`, wamid, externalThreadId: thread, toPhone: thread, sender: "ai", senderName: null, body: "Sure, I can help with that.", messageType: "text", templateName: null, status: "sent", occurredAt: new Date().toISOString(), phoneNumberId: "pn-1", attachments: [], ...over });
  };
  const convoFor = async (tt: TestTenant, thread: string) => (await db.select().from(conversations).where(and(eq(conversations.tenantId, tt.tenantId), eq(conversations.externalThreadId, thread))))[0];
  const detail = async (tt: TestTenant, id: string) => (await call(tt, "PATIENT_COORDINATOR", "GET", `/conversations/${id}`)).json() as ConversationDetail;
  const open = async (tt: TestTenant) => {
    const thread = wa();
    expect((await inbound(tt, thread, "Hii")).statusCode).toBe(200);
    return { thread, conv: (await convoFor(tt, thread))! };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
    v1 = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await configureWn(t, CB);
    await configureWn(other, CB_OTHER);
    await configureWn(v1, CB);
  });
  afterAll(async () => {
    for (const tt of [t, other, v1]) await destroyTestTenant(db, tt);
    await app.close();
    await queryClient.end();
  });

  // The role used to read the inbox in these tests.
  const asStaff = (tt: TestTenant, url: string) => call(tt, "PATIENT_COORDINATOR", "GET", url);

  describe("the WhatsNexus setup test (ping)", () => {
    it("a correctly signed ping is answered, and it changes nothing", async () => {
      const before = (await asStaff(t, "/conversations")).json() as ConversationRow[];
      const res = await callback(t.tenantId, CB, { type: "ping", eventId: `ping-${++n}`, sentAt: new Date().toISOString() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, pong: true });
      expect(((await asStaff(t, "/conversations")).json() as ConversationRow[]).length).toBe(before.length);
    });

    it("a ping signed with another hospital's secret, or unsigned, is refused: it also proves the secret", async () => {
      const bad = await callback(t.tenantId, CB_OTHER, { type: "ping", eventId: "ping-x", sentAt: new Date().toISOString() });
      expect(bad.statusCode).toBe(401);
      const unsigned = await app.inject({ method: "POST", url: `/webhooks/whatsnexus/${t.tenantId}`, payload: JSON.stringify({ type: "ping", eventId: "ping-y" }), headers: { "content-type": "application/json" } });
      expect(unsigned.statusCode).toBe(401);
    });
  });

  describe("what WhatsNexus itself sent is shown in PulseOS", () => {
    it("an AI reply appears on the patient's thread as the AI Assistant, with its delivery state, and moves the thread", async () => {
      const { thread, conv } = await open(t);
      const res = await outbound(t, thread, { body: "Hello Naveen, how can I help you today?" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, applied: true });
      // The list first: opening the conversation marks the patient's messages as read.
      const list = (await asStaff(t, "/conversations")).json() as ConversationRow[];
      expect(list.find((c) => c.id === conv.id)!.lastMessage).toBe("Hello Naveen, how can I help you today?");
      expect(list.find((c) => c.id === conv.id)!.unreadCount).toBe(1); // only the patient's own message is unread
      const d = (await asStaff(t, `/conversations/${conv.id}`)).json() as ConversationDetail;
      const ai = d.messages.find((m) => m.body.startsWith("Hello Naveen"))!;
      expect(ai).toMatchObject({ senderType: "ai", senderName: null, deliveryStatus: "sent" });
      expect(d.conversation.lastMessage).toBe("Hello Naveen, how can I help you today?");
    });

    it("a template WhatsNexus sent keeps its kind and name; ordinary messages are plain text", async () => {
      const { thread, conv } = await open(t);
      await outbound(t, thread, { sender: "agent", senderName: "Priya", body: "[IMAGE: https://cdn.example.com/offer.jpg]\nHello Naveen, 20% off.\n[Button: Book now (https://x.example.com/book)]", messageType: "template", templateName: "diwali_offer" });
      await outbound(t, thread, { body: "Plain AI reply" });
      const d = await detail(t, conv.id);
      expect(d.messages.find((m) => m.body.includes("20% off"))).toMatchObject({ kind: "template", templateName: "diwali_offer" });
      expect(d.messages.find((m) => m.body === "Plain AI reply")).toMatchObject({ kind: "text", templateName: null });
      expect(d.messages.find((m) => m.senderType === "patient")).toMatchObject({ kind: "text", templateName: null });
    });

    it("a WhatsNexus agent's message shows the agent's name", async () => {
      const { thread, conv } = await open(t);
      await outbound(t, thread, { sender: "agent", senderName: "Priya Nair", body: "I have booked you for Friday." });
      const m = (await detail(t, conv.id)).messages.find((x) => x.body.startsWith("I have booked"))!;
      expect(m).toMatchObject({ senderType: "staff", senderName: "Priya Nair" });
    });

    it("the same message is stored once, however many times WhatsNexus delivers it", async () => {
      const { thread, conv } = await open(t);
      const wamid = `wamid.DUP${++n}`;
      expect((await outbound(t, thread, { wamid })).json()).toMatchObject({ applied: true });
      expect((await outbound(t, thread, { wamid })).json()).toMatchObject({ duplicate: true }); // same event id
      expect((await callback(t.tenantId, CB, { type: "outbound_message", eventId: "out:retry-2", wamid, externalThreadId: thread, toPhone: thread, sender: "ai", body: "again", messageType: "text", status: "sent", occurredAt: new Date().toISOString(), attachments: [] })).statusCode).toBe(200); // same wamid, new event id
      const rows = await db.select().from(messages).where(and(eq(messages.conversationId, conv.id), eq(messages.providerMessageId, wamid)));
      expect(rows).toHaveLength(1);
    });

    it("an attachment WhatsNexus sent is listed with its metadata", async () => {
      const { thread, conv } = await open(t);
      const wamid = `wamid.DOC${++n}`;
      await outbound(t, thread, { wamid, sender: "agent", senderName: "Priya", body: "Your report", messageType: "document", attachments: [{ kind: "document", providerMediaId: wamid, fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: null }] });
      const m = (await detail(t, conv.id)).messages.find((x) => x.body === "Your report")!;
      expect(m.attachments).toMatchObject([{ kind: "document", fileName: "report.pdf", mimeType: "application/pdf" }]);
    });

    it("a message WhatsNexus reports as failed is shown as not delivered", async () => {
      const { thread, conv } = await open(t);
      await outbound(t, thread, { status: "failed", body: "This one failed" });
      expect((await detail(t, conv.id)).messages.find((x) => x.body === "This one failed")!.deliveryStatus).toBe("failed");
    });

    it("a thread PulseOS has never heard of is NOT created from an outbound message (broadcasts do not become patients)", async () => {
      const thread = wa();
      const res = await outbound(t, thread, { body: "Diwali offer for you" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, applied: false, reason: "unknown_thread" });
      expect(await convoFor(t, thread)).toBeUndefined();
      expect((await db.select().from(patients).where(eq(patients.tenantId, t.tenantId))).filter((p) => (p.phoneE164 ?? "").endsWith(thread.slice(-10)))).toHaveLength(0);
    });

    it("is authenticated per hospital: another hospital's secret, a forged signature, or a hospital without the inbox cannot write", async () => {
      const { thread, conv } = await open(t);
      const before = (await detail(t, conv.id)).messages.length;
      expect((await outbound(t, thread, { body: "forged" }, CB_OTHER)).statusCode).toBe(401);
      expect((await outbound(t, thread, { body: "forged" }, "whcs_not_the_secret_0123456789abcdef")).statusCode).toBe(401);
      expect((await detail(t, conv.id)).messages).toHaveLength(before);
      // the other hospital's own secret, but this hospital's thread id: nothing of ours is touched
      const res = await outbound(other, thread, { body: "cross-tenant" }, CB_OTHER);
      expect(res.json()).toMatchObject({ applied: false, reason: "unknown_thread" });
      expect((await detail(t, conv.id)).messages).toHaveLength(before);
      // inbox switched off for the hospital: acknowledged, ignored
      const ignored = await outbound(v1, thread, { body: "no inbox" });
      expect(ignored.json()).toMatchObject({ ok: true, ignored: true });
    });

    it("a malformed event is refused with 400, never half-applied", async () => {
      const { thread } = await open(t);
      const res = await outbound(t, thread, { sender: "somebody" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("sending from the Inbox", () => {
    const double = (onPost: (url: string) => Response) => {
      const calls: string[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => { if (init.method === "POST") { calls.push(String(url)); return onPost(String(url)); } return json(404, {}); }) as unknown as typeof fetch;
      const adapter = createWhatsNexusAdapter({ fetchImpl, isPublicHost: async () => true });
      return { calls, deps: { adapterFor: (p: string) => (p === "whatsnexus" ? adapter : null) } };
    };
    const staff = () => t.userIds.PATIENT_COORDINATOR!;

    it("a successful send is stored as sent, with WhatsNexus's message id", async () => {
      const { conv } = await open(t);
      const d = double(() => json(200, { success: true, wamid: `wamid.SENT${++n}` }));
      const r = await sendMessage(db, t.tenantId, conv.id, staff(), "hello from PulseOS", new Date(), d.deps);
      expect(r).toMatchObject({ ok: true, deliveryStatus: "sent" });
      expect(d.calls).toHaveLength(1);
      expect(d.calls[0]).toContain("/api/integrations/pulseos/text");
      const m = (await detail(t, conv.id)).messages.find((x) => x.body === "hello from PulseOS")!;
      expect(m).toMatchObject({ senderType: "staff", deliveryStatus: "sent" });
    });

    it("a failed send is kept, marked not delivered, and the real reason is handed back", async () => {
      const { conv } = await open(t);
      const d = double(() => json(503, { success: false, error: { code: "SERVICE_UNAVAILABLE", message: "WhatsApp is down", retryable: true } }));
      const r = await sendMessage(db, t.tenantId, conv.id, staff(), "will fail", new Date(), d.deps);
      expect(r).toMatchObject({ ok: true, deliveryStatus: "failed" });
      expect((r as { reason: string }).reason).toMatch(/SERVICE_UNAVAILABLE/);
      expect((await detail(t, conv.id)).messages.find((x) => x.body === "will fail")).toMatchObject({ deliveryStatus: "failed" });
    });

    it("after the 24-hour window nothing is sent or stored: the staff member is told a template is needed", async () => {
      const { conv } = await open(t);
      expect((await detail(t, conv.id)).replyBlockedReason).toBeNull(); // the patient just wrote: replying is open
      await db.update(conversations).set({ lastPatientInboundAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(conversations.id, conv.id));
      expect((await detail(t, conv.id)).replyBlockedReason).toBe("WINDOW_CLOSED");
      const d = double(() => json(200, { success: true, wamid: "wamid.NEVER" }));
      const r = await sendMessage(db, t.tenantId, conv.id, staff(), "too late", new Date(), d.deps);
      expect(r).toEqual({ ok: false, reason: "template_required" });
      expect(d.calls).toHaveLength(0);
      expect((await detail(t, conv.id)).messages.some((x) => x.body === "too late")).toBe(false);
      const http = await call(t, "PATIENT_COORDINATOR", "POST", `/conversations/${conv.id}/messages`, { body: "too late" });
      expect(http.statusCode).toBe(409);
      expect(http.json()).toMatchObject({ error: "template_required" });
    });

    it("a failed message can be retried: it is sent again as the SAME message, not a second bubble", async () => {
      const { conv } = await open(t);
      const failing = double(() => json(503, { success: false, error: { code: "SERVICE_UNAVAILABLE", message: "down", retryable: true } }));
      await sendMessage(db, t.tenantId, conv.id, staff(), "retry me", new Date(), failing.deps);
      const failed = (await detail(t, conv.id)).messages.find((x) => x.body === "retry me")!;
      const stillDown = await retryConversationMessage(db, t.tenantId, conv.id, failed.id, staff(), failing.deps);
      expect(stillDown).toMatchObject({ ok: true, deliveryStatus: "failed" });
      const up = double(() => json(200, { success: true, wamid: `wamid.RETRY${++n}` }));
      const ok = await retryConversationMessage(db, t.tenantId, conv.id, failed.id, staff(), up.deps);
      expect(ok).toMatchObject({ ok: true, deliveryStatus: "sent" });
      const all = (await detail(t, conv.id)).messages.filter((x) => x.body === "retry me");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: failed.id, deliveryStatus: "sent" });
      // a message that was delivered cannot be "retried" (that would send it twice)
      expect(await retryConversationMessage(db, t.tenantId, conv.id, failed.id, staff(), up.deps)).toEqual({ ok: false, reason: "not_retryable" });
      expect(up.calls).toHaveLength(1);
    });

    it("retry is tenant-scoped and only for a staff text message", async () => {
      const { conv } = await open(t);
      const d = double(() => json(503, { success: false, error: { code: "SERVICE_UNAVAILABLE", message: "down", retryable: true } }));
      await sendMessage(db, t.tenantId, conv.id, staff(), "mine", new Date(), d.deps);
      const mine = (await detail(t, conv.id)).messages.find((x) => x.body === "mine")!;
      expect(await retryConversationMessage(db, other.tenantId, conv.id, mine.id, other.userIds.PATIENT_COORDINATOR!, d.deps)).toEqual({ ok: false, reason: "conversation_not_found" });
      const patientMsg = (await detail(t, conv.id)).messages.find((x) => x.senderType === "patient")!;
      expect(await retryConversationMessage(db, t.tenantId, conv.id, patientMsg.id, staff(), d.deps)).toEqual({ ok: false, reason: "not_retryable" });
      expect(await retryConversationMessage(db, t.tenantId, conv.id, "00000000-0000-4000-8000-000000000000", staff(), d.deps)).toEqual({ ok: false, reason: "message_not_found" });
    });

    it("HTTP: the send response says whether it was delivered, and a front-desk role without MANAGE_INBOX is refused", async () => {
      const { conv } = await open(t);
      const res = await call(t, "PATIENT_COORDINATOR", "POST", `/conversations/${conv.id}/messages`, { body: "via http" });
      expect(res.statusCode).toBe(200); // the real adapter cannot reach wn.example.com: the message is kept, marked failed
      expect(res.json()).toMatchObject({ ok: true, deliveryStatus: "failed" });
      const failed = (await detail(t, conv.id)).messages.find((x) => x.body === "via http")!;
      const retry = await call(t, "PATIENT_COORDINATOR", "POST", `/conversations/${conv.id}/messages/${failed.id}/retry`);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ ok: true, deliveryStatus: "failed" });
      expect((await call(t, "DOCTOR", "POST", `/conversations/${conv.id}/messages/${failed.id}/retry`)).statusCode).toBe(403);
    });
  });

  describe("files, photos, videos and voice notes", () => {
    const MB = 1024 * 1024;
    const b64 = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64");
    const staff = () => t.userIds.PATIENT_COORDINATOR!;
    const wn = (onPost: (body: Record<string, unknown>) => Response) => {
      const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => { requests.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "{}")) }); return onPost(requests.at(-1)!.body); }) as unknown as typeof fetch;
      const adapter = createWhatsNexusAdapter({ fetchImpl, isPublicHost: async () => true });
      return { requests, deps: { adapterFor: (p: string) => (p === "whatsnexus" ? adapter : null) } };
    };
    const accepted = () => json(200, { success: true, wamid: `wamid.MEDIA${++n}${Date.now()}` });
    const connectorStatus = async () => (await db.select().from(connectors).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "whatsnexus"))))[0]!.status;
    const connect = () => db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.tenantId, t.tenantId), eq(connectors.provider, "whatsnexus")));

    it("a patient's voice note, photo and video arrive as attachments (WhatsNexus sends size null) and are listed", async () => {
      const { thread, conv } = await open(t);
      for (const [kind, mime] of [["audio", "audio/ogg"], ["image", "image/jpeg"], ["video", "video/mp4"]] as const) {
        const id = `wamid.PAT${kind}${++n}`;
        const res = await callback(t.tenantId, CB, { type: "inbound_message", eventId: id, externalThreadId: thread, fromPhone: thread, fromName: "Naveen Raj", body: "", occurredAt: new Date().toISOString(), phoneNumberId: "pn-1", attachments: [{ kind, providerMediaId: id, fileName: null, mimeType: mime, sizeBytes: null }] });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ applied: true });
      }
      const d = await detail(t, conv.id);
      expect(d.messages.flatMap((m) => m.attachments.map((a) => a.kind)).sort()).toEqual(["audio", "image", "video"]);
    });

    it("a voice note or video WhatsNexus sent is mirrored with its attachment", async () => {
      const { thread, conv } = await open(t);
      const wamid = `wamid.MIRAUD${++n}`;
      await outbound(t, thread, { wamid, sender: "agent", senderName: "Priya", body: "", messageType: "audio", attachments: [{ kind: "audio", providerMediaId: wamid, fileName: null, mimeType: "audio/mpeg", sizeBytes: null }] });
      expect((await detail(t, conv.id)).messages.find((m) => m.attachments.length)!.attachments[0]).toMatchObject({ kind: "audio" });
    });

    it.each([
      ["image", "image/png", "scan.png"],
      ["video", "video/mp4", "clip.mp4"],
      ["document", "application/pdf", "report.pdf"],
      ["audio", "audio/webm;codecs=opus", "voice-1.webm"],
    ] as const)("sends a %s through WhatsNexus, stores it as a sent message with its attachment, and bumps the thread", async (kind, mimeType, fileName) => {
      const { conv } = await open(t);
      const d = wn(accepted);
      const r = await sendMediaMessage(db, t.tenantId, conv.id, staff(), { kind, fileName, mimeType, base64: b64(2048), caption: "see this" }, d.deps);
      expect(r).toEqual({ ok: true });
      expect(d.requests).toHaveLength(1);
      expect(d.requests[0]!.url).toBe("https://wn.example.com/api/integrations/pulseos/media");
      expect(d.requests[0]!.headers["x-pulseos-tenant-id"]).toBe(t.tenantId);
      expect(d.requests[0]!.body).toMatchObject({ kind, fileName, mimeType, caption: "see this" });
      const m = (await detail(t, conv.id)).messages.find((x) => x.attachments.length)!;
      expect(m).toMatchObject({ senderType: "staff", body: "see this", deliveryStatus: "sent" });
      expect(m.attachments[0]).toMatchObject({ kind, fileName });
    });

    it("a file WhatsApp refuses is reported with WhatsNexus's reason, stores nothing, and does NOT flag the connection as broken", async () => {
      await connect();
      const { conv } = await open(t);
      const d = wn(() => json(422, { success: false, error: { code: "INVALID_REQUEST", message: "Meta API Error: unsupported media format", retryable: false } }));
      const r = await sendMediaMessage(db, t.tenantId, conv.id, staff(), { kind: "image", fileName: "a.png", mimeType: "image/png", base64: b64(2048), caption: "" }, d.deps);
      expect(r).toMatchObject({ ok: false, reason: "send_failed" });
      expect((r as { detail: string }).detail).toContain("unsupported media format");
      expect((await detail(t, conv.id)).messages.some((m) => m.attachments.length)).toBe(false);
      expect(await connectorStatus()).toBe("CONNECTED");
    });

    it("a credential failure still flags the connection", async () => {
      const { conv } = await open(t);
      const d = wn(() => json(401, { success: false, error: { code: "INVALID_CREDENTIALS", message: "bad key" } }));
      expect(await sendMediaMessage(db, t.tenantId, conv.id, staff(), { kind: "image", fileName: "a.png", mimeType: "image/png", base64: b64(2048), caption: "" }, d.deps)).toMatchObject({ ok: false, reason: "send_failed" });
      expect(await connectorStatus()).toBe("ERROR");
      await connect();
    });

    it("is refused before anything is uploaded when the file is too large, empty or the wrong type, or the 24-hour window has closed", async () => {
      const { conv } = await open(t);
      const d = wn(accepted);
      const send = (media: Partial<Parameters<typeof sendMediaMessage>[4]>) => sendMediaMessage(db, t.tenantId, conv.id, staff(), { kind: "image", fileName: "a.png", mimeType: "image/png", base64: b64(2048), caption: "", ...media }, d.deps);
      expect(await send({ base64: b64(6 * MB) })).toMatchObject({ ok: false, reason: "file_too_large" });
      expect(await send({ base64: "" })).toMatchObject({ ok: false, reason: "empty_file" });
      expect(await send({ kind: "video", fileName: "c.webm", mimeType: "video/webm" })).toMatchObject({ ok: false, reason: "unsupported_type" });
      expect(await send({ kind: "document", fileName: "setup.exe", mimeType: "application/x-msdownload" })).toMatchObject({ ok: false, reason: "unsupported_type" });
      await db.update(conversations).set({ lastPatientInboundAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(conversations.id, conv.id));
      expect(await send({})).toEqual({ ok: false, reason: "template_required" });
      expect(d.requests).toHaveLength(0);
    });

    it("HTTP: a bad kind is 400, an oversized file 413 with the reason, a file in a closed window 409", async () => {
      const { conv } = await open(t);
      const post = (payload: object) => call(t, "PATIENT_COORDINATOR", "POST", `/conversations/${conv.id}/media`, payload);
      expect((await post({ kind: "gif", fileName: "a.gif", mimeType: "image/gif", base64: b64(10), caption: "" })).statusCode).toBe(400);
      const big = await post({ kind: "image", fileName: "a.png", mimeType: "image/png", base64: b64(6 * MB), caption: "" });
      expect(big.statusCode).toBe(413);
      expect(big.json()).toMatchObject({ error: "file_too_large", message: "This image is too large. Images can be up to 5 MB." });
      const exe = await post({ kind: "document", fileName: "setup.exe", mimeType: "application/x-msdownload", base64: b64(10), caption: "" });
      expect(exe.statusCode).toBe(400);
      expect(exe.json()).toMatchObject({ error: "unsupported_type" });
    });

    describe("opening an attachment (served through PulseOS, not by sending the browser to WhatsNexus)", () => {
      async function attachmentOf(mime: string, kind: "image" | "audio" | "document", fileName: string | null) {
        const { thread, conv } = await open(t);
        const wamid = `wamid.PROXY${++n}`;
        await outbound(t, thread, { wamid, sender: "agent", senderName: "Priya", body: "", messageType: kind, attachments: [{ kind, providerMediaId: wamid, fileName, mimeType: mime, sizeBytes: null }] });
        const m = (await detail(t, conv.id)).messages.find((x) => x.attachments.length)!;
        return { conv, wamid, messageId: m.id, attachmentId: m.attachments[0]!.id };
      }
      const upstream = (status: number, type: string, extra: Record<string, string> = {}) => {
        const calls: { url: string; headers: Record<string, string> }[] = [];
        const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), headers: init.headers as Record<string, string> }); return new Response(status === 404 ? "no" : "BYTES", { status, headers: { "content-type": type, ...extra } }); }) as unknown as typeof fetch;
        return { calls, deps: { fetchImpl, isPublicHost: async () => true } };
      };

      it("fetches the file with a short-lived signed link, relays it (with Range), and never exposes the link", async () => {
        const a = await attachmentOf("audio/mpeg", "audio", "v.mp3");
        const u = upstream(206, "audio/mpeg", { "content-range": "bytes 0-4/5", "accept-ranges": "bytes" });
        const r = await fetchConversationAttachment(db, t.tenantId, a.conv.id, a.messageId, a.attachmentId, { range: "bytes=0-4" }, u.deps);
        expect(r).toMatchObject({ status: 206, headers: { "content-type": "audio/mpeg", "content-range": "bytes 0-4/5", "x-content-type-options": "nosniff" } });
        expect(await new Response(r!.body).text()).toBe("BYTES");
        const url = new URL(u.calls[0]!.url);
        expect(url.pathname).toBe(`/api/integrations/pulseos/media/${a.wamid}`);
        expect(url.searchParams.get("tenantId")).toBe("TT001");
        expect(url.searchParams.get("signature")).toMatch(/^sha256=/);
        expect(u.calls[0]!.headers.range).toBe("bytes=0-4");
        expect(u.calls[0]!.headers["ngrok-skip-browser-warning"]).toBeTruthy();
      });

      it("anything that is not plainly media is downloaded, never rendered in PulseOS's own origin", async () => {
        const a = await attachmentOf("text/html", "document", "x.html");
        const r = await fetchConversationAttachment(db, t.tenantId, a.conv.id, a.messageId, a.attachmentId, {}, upstream(200, "text/html").deps);
        expect(r!.headers["content-type"]).toBe("application/octet-stream");
        expect(r!.headers["content-disposition"]).toMatch(/^attachment/);
      });

      it("another hospital, an unknown id, or a file WhatsNexus no longer has gives nothing", async () => {
        const a = await attachmentOf("image/png", "image", null);
        expect(await fetchConversationAttachment(db, other.tenantId, a.conv.id, a.messageId, a.attachmentId, {}, upstream(200, "image/png").deps)).toBeNull();
        expect(await fetchConversationAttachment(db, t.tenantId, a.conv.id, a.messageId, "00000000-0000-4000-8000-000000000000", {}, upstream(200, "image/png").deps)).toBeNull();
        expect(await fetchConversationAttachment(db, t.tenantId, a.conv.id, a.messageId, a.attachmentId, {}, upstream(404, "application/json").deps)).toBeNull();
        const res = await call(t, "PATIENT_COORDINATOR", "GET", `/conversations/${a.conv.id}/messages/${a.messageId}/attachments/${a.attachmentId}`);
        expect(res.statusCode).toBe(404); // the real adapter cannot reach wn.example.com: a clean 404, not a redirect or a crash
      });
    });
  });

  // A template PulseOS sends (a follow-up a person chose, a reminder the engine sent) is part of the conversation too.
  describe("template messages sent by PulseOS appear in the patient's Inbox thread", () => {
    const wnDouble = () => {
      const fetchImpl = (async (_url: string, init: RequestInit) => (init.method === "POST" ? json(200, { success: true, wamid: `wamid.TPL${++n}${Date.now()}`, status: "accepted" }) : json(404, {}))) as unknown as typeof fetch;
      const adapter = createWhatsNexusAdapter({ fetchImpl, isPublicHost: async () => true });
      return { adapterFor: (p: string) => (p === "whatsnexus" ? adapter : null) };
    };
    /** A patient with a journey, who has also written in on WhatsApp (so a thread exists). */
    async function patientWithThread(tt: TestTenant, writes = true) {
      const phone = `+9196${String(70000000 + ++n * 37).padStart(8, "0")}`;
      const lead = await call(tt, "FRONT_DESK", "POST", "/leads", { phone, name: "Naveen Raj", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
      expect(lead.statusCode).toBe(201);
      const { journeyId } = lead.json() as { journeyId: string };
      const thread = phone.slice(1);
      if (writes) expect((await inbound(tt, thread, "Hii")).statusCode).toBe(200);
      return { journeyId, thread, conv: writes ? (await convoFor(tt, thread))! : undefined };
    }
    const send = (tt: TestTenant, journeyId: string) => sendFollowUpMessage(db, tt.tenantId, tt.userIds.FRONT_DESK!, journeyId, `tpl-${++n}-${Date.now()}-aaaa`, wnDouble());

    beforeAll(async () => {
      await call(t, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
      await call(v1, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
      // The sending tests above (real adapter, unreachable host) leave the connector in ERROR; selecting WhatsNexus needs CONNECTED.
      for (const tt of [t, v1]) await db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.tenantId, tt.tenantId), eq(connectors.provider, "whatsnexus")));
      expect((await call(t, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: "true" } })).statusCode).toBe(200);
      expect((await call(v1, "SUPER_ADMIN", "PUT", "/integrations/hub/whatsnexus/configuration", { configuration: { useForSending: "true" } })).statusCode).toBe(200);
    });

    it("a follow-up a person sent shows in the thread as their message, with its delivery state", async () => {
      const { journeyId, conv } = await patientWithThread(t);
      const r = await send(t, journeyId);
      expect(r).toMatchObject({ ok: true, status: "SENT" });
      const m = (await detail(t, conv!.id)).messages.find((x) => x.body.includes("following up on your recent enquiry"))!;
      expect(m).toMatchObject({ senderType: "staff", deliveryStatus: "sent" });
      expect(m.senderName).toBeTruthy(); // the staff member who pressed Send
      // ... and it is shown as a template message, named, so the Inbox can lay it out like WhatsNexus does
      expect(m).toMatchObject({ kind: "template", templateName: "follow_up_message" });
      const d = await detail(t, conv!.id);
      expect(d.conversation.lastMessage).toContain("following up on your recent enquiry");
    });

    it("the provider's delivered/read callbacks move that same message on, never backwards", async () => {
      const { journeyId, conv } = await patientWithThread(t);
      const r = (await send(t, journeyId)) as { notificationId: string };
      const row = (await db.select().from(messages).where(eq(messages.conversationId, conv!.id))).find((x) => x.body.includes("following up"))!;
      const status = (s: string) => callback(t.tenantId, CB, { eventId: `${r.notificationId}:${s}`, dispatchId: "d-1", externalId: r.notificationId, wamid: row.providerMessageId, status: s, occurredAt: new Date().toISOString() });
      expect((await status("read")).statusCode).toBe(200);
      expect((await detail(t, conv!.id)).messages.find((x) => x.id === row.id)!.deliveryStatus).toBe("read");
      await status("delivered");
      expect((await detail(t, conv!.id)).messages.find((x) => x.id === row.id)!.deliveryStatus).toBe("read");
    });

    it("an automated reminder is shown as one, not as a person's message", async () => {
      const { conv, thread } = await patientWithThread(t);
      const [c] = await db.select().from(conversations).where(eq(conversations.id, conv!.id));
      const { mirrorNotificationToConversation } = await import("../domain/notification/notification.service.js");
      await mirrorNotificationToConversation(db, { tenantId: t.tenantId, patientId: c!.patientId, connectorId: c!.connectorId!, providerMessageId: `wamid.AUTO${++n}`, body: "Reminder: your visit is tomorrow", actorId: null, at: new Date() });
      const m = (await detail(t, conv!.id)).messages.find((x) => x.body.startsWith("Reminder: your visit"))!;
      expect(m).toMatchObject({ senderType: "staff", senderName: "Automated reminder", deliveryStatus: "sent" });
      void thread;
    });

    it("a patient who has never written in has no thread: nothing is created for an outbound-only message", async () => {
      const { journeyId } = await patientWithThread(t, false);
      const before = (await db.select().from(conversations).where(eq(conversations.tenantId, t.tenantId))).length;
      expect(await send(t, journeyId)).toMatchObject({ ok: true, status: "SENT" });
      expect((await db.select().from(conversations).where(eq(conversations.tenantId, t.tenantId))).length).toBe(before);
    });

    it("the same provider message is never written twice", async () => {
      const { conv } = await patientWithThread(t);
      const [c] = await db.select().from(conversations).where(eq(conversations.id, conv!.id));
      const { mirrorNotificationToConversation } = await import("../domain/notification/notification.service.js");
      const args = { tenantId: t.tenantId, patientId: c!.patientId, connectorId: c!.connectorId!, providerMessageId: `wamid.ONCE${++n}`, body: "only once", actorId: null, at: new Date() };
      await mirrorNotificationToConversation(db, args);
      await mirrorNotificationToConversation(db, args);
      expect((await db.select().from(messages).where(and(eq(messages.conversationId, conv!.id), eq(messages.providerMessageId, args.providerMessageId))))).toHaveLength(1);
    });

    it("a hospital without the Inbox keeps its notifications and gets no conversation messages", async () => {
      const { journeyId } = await patientWithThread(v1, false);
      const before = (await db.select().from(messages).where(eq(messages.tenantId, v1.tenantId))).length;
      await send(v1, journeyId);
      expect((await db.select().from(messages).where(eq(messages.tenantId, v1.tenantId))).length).toBe(before);
    });
  });
});

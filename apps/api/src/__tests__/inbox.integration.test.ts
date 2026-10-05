import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConversationRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("inbox / conversations (integration)", () => {
  let app: FastifyInstance;
  let coordinatorCookie: string;
  let doctorCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations" });
    expect(res.statusCode).toBe(401);
  });

  it("doctor role (no VIEW_INBOX) cannot view the inbox", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("VIEW_INBOX");
  });

  it("coordinator sees the conversation list across channels", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations", cookies: { pulseos_session: coordinatorCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as ConversationRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.patientName).toBeTruthy();
      expect(["WHATSAPP", "CALL", "SMS", "EMAIL", "INTERNAL"]).toContain(row.channel);
    }
  });

  it("filters by ownership state", async () => {
    const res = await app.inject({ method: "GET", url: "/conversations?ownershipState=HUMAN_REQUIRED", cookies: { pulseos_session: coordinatorCookie } });
    const rows = res.json() as ConversationRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.ownershipState).toBe("HUMAN_REQUIRED");
  });

  it("full lifecycle on one conversation needing attention: claim, send a message, then return to AI", async () => {
    const list = await app.inject({ method: "GET", url: "/conversations?ownershipState=HUMAN_REQUIRED", cookies: { pulseos_session: coordinatorCookie } });
    const target = (list.json() as ConversationRow[])[0];

    const claim = await app.inject({ method: "PATCH", url: `/conversations/${target.id}/claim`, cookies: { pulseos_session: coordinatorCookie } });
    expect(claim.statusCode).toBe(200);

    const afterClaim = await app.inject({ method: "GET", url: `/conversations/${target.id}`, cookies: { pulseos_session: coordinatorCookie } });
    expect(afterClaim.statusCode).toBe(200);
    const detail = afterClaim.json();
    expect(detail.conversation.ownershipState).toBe("HUMAN_ACTIVE");
    expect(detail.conversation.ownerName).toBeTruthy();
    expect(Array.isArray(detail.messages)).toBe(true);

    const send = await app.inject({
      method: "POST", url: `/conversations/${target.id}/messages`, cookies: { pulseos_session: coordinatorCookie },
      payload: { body: "Thanks for waiting — here's the update on your treatment plan." },
    });
    expect(send.statusCode).toBe(200);

    // "Return to AI" must NEVER pretend an AI runtime actually resumed the
    // conversation — no such runtime exists yet in this checkpoint. It hands
    // off to a real, honest AI_RESUME_PENDING state, not back to AI_ACTIVE.
    const returnToAi = await app.inject({ method: "PATCH", url: `/conversations/${target.id}/return-to-ai`, cookies: { pulseos_session: coordinatorCookie } });
    expect(returnToAi.statusCode).toBe(200);

    const afterReturn = await app.inject({ method: "GET", url: `/conversations/${target.id}`, cookies: { pulseos_session: coordinatorCookie } });
    const finalDetail = afterReturn.json();
    expect(finalDetail.conversation.ownershipState).toBe("AI_RESUME_PENDING");
    expect(finalDetail.conversation.ownerName).toBeNull();
    expect(finalDetail.messages.some((m: { body: string }) => m.body.includes("here's the update"))).toBe(true);

    // A human can always reclaim a conversation out of AI_RESUME_PENDING.
    const reclaim = await app.inject({ method: "PATCH", url: `/conversations/${target.id}/claim`, cookies: { pulseos_session: coordinatorCookie } });
    expect(reclaim.statusCode).toBe(200);

    const close = await app.inject({ method: "PATCH", url: `/conversations/${target.id}/close`, cookies: { pulseos_session: coordinatorCookie } });
    expect(close.statusCode).toBe(200);
    const afterClose = await app.inject({ method: "GET", url: `/conversations/${target.id}`, cookies: { pulseos_session: coordinatorCookie } });
    expect(afterClose.json().conversation.ownershipState).toBe("CLOSED");

    // A closed conversation rejects further ownership transitions (409).
    const claimAfterClose = await app.inject({ method: "PATCH", url: `/conversations/${target.id}/claim`, cookies: { pulseos_session: coordinatorCookie } });
    expect(claimAfterClose.statusCode).toBe(409);

    const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const events = timeline.json() as { eventType: string; description: string | null }[];
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("conversation_claimed");
    expect(eventTypes).toContain("conversation_returned_to_ai");
    expect(eventTypes).toContain("conversation_closed");

    // The staff reply is part of the same conversation session as the patient's messages: the Timeline has ONE
    // concise line for the session (not one per message), and the raw reply stays in the conversation.
    expect(events.filter((e) => e.eventType === "whatsapp_message")).toHaveLength(0);
    expect(events.some((e) => e.eventType === "whatsapp_conversation")).toBe(true);
    const threadAfter = (await app.inject({ method: "GET", url: `/conversations/${target.id}`, cookies: { pulseos_session: coordinatorCookie } })).json() as { messages: { body: string }[] };
    expect(threadAfter.messages.some((m) => m.body.includes("here's the update"))).toBe(true);
  });

  it("assigning a conversation writes a distinct conversation_assigned Timeline event (not conversation_claimed)", async () => {
    const list = await app.inject({ method: "GET", url: "/conversations?ownershipState=HUMAN_REQUIRED", cookies: { pulseos_session: coordinatorCookie } });
    const rows = list.json() as ConversationRow[];
    expect(rows.length).toBeGreaterThan(0);
    const target = rows[0];

    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: coordinatorCookie } });
    const owner = lookups.json().owners[0];

    const assign = await app.inject({
      method: "PATCH", url: `/conversations/${target.id}/assign`, cookies: { pulseos_session: coordinatorCookie },
      payload: { assignedTo: owner.id },
    });
    expect(assign.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/conversations/${target.id}`, cookies: { pulseos_session: coordinatorCookie } });
    expect(detail.json().conversation.ownershipState).toBe("HUMAN_ASSIGNED");

    const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("conversation_assigned");
  });

  it("rejects claiming a conversation that does not exist", async () => {
    const res = await app.inject({ method: "PATCH", url: "/conversations/00000000-0000-0000-0000-000000000000/claim", cookies: { pulseos_session: coordinatorCookie } });
    expect(res.statusCode).toBe(404);
  });

  describe("per-conversation AI scheduling preference (config only — no agent runtime)", () => {
    it("defaults to manual with no schedule when never configured", async () => {
      const list = await app.inject({ method: "GET", url: "/conversations", cookies: { pulseos_session: coordinatorCookie } });
      const target = (list.json() as ConversationRow[])[0];

      const res = await app.inject({ method: "GET", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: coordinatorCookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mode).toBe("manual");
      expect(body.scheduledStart).toBeNull();
      expect(body.scheduledEnd).toBeNull();
    });

    it("rejects ai_scheduled mode without a scheduledStart/scheduledEnd/timezone", async () => {
      const list = await app.inject({ method: "GET", url: "/conversations", cookies: { pulseos_session: coordinatorCookie } });
      const target = (list.json() as ConversationRow[])[0];

      const res = await app.inject({
        method: "PATCH", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: coordinatorCookie },
        payload: { mode: "ai_scheduled" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("schedule_required");
    });

    it("saves an ai_scheduled preference, reflects it on GET, and writes a Timeline event — MANAGE_INBOX only", async () => {
      const list = await app.inject({ method: "GET", url: "/conversations", cookies: { pulseos_session: coordinatorCookie } });
      const target = (list.json() as ConversationRow[])[0];

      // No role currently has VIEW_INBOX without MANAGE_INBOX (they're always granted
      // together — see ROLE_PERMISSIONS), so the MANAGE_INBOX preHandler on this route
      // can't be distinguished from the module-wide VIEW_INBOX hook with today's roles.
      // It's still declared (matching every other mutation route in this file) for when
      // that changes; here we can only assert doctor is blocked at all.
      const doctorAttempt = await app.inject({
        method: "PATCH", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: doctorCookie },
        payload: { mode: "manual" },
      });
      expect(doctorAttempt.statusCode).toBe(403);
      expect(doctorAttempt.json().requiredPermission).toBe("VIEW_INBOX");

      const scheduledStart = new Date(Date.now() + 3600_000).toISOString();
      const scheduledEnd = new Date(Date.now() + 7200_000).toISOString();
      const save = await app.inject({
        method: "PATCH", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: coordinatorCookie },
        payload: { mode: "ai_scheduled", scheduledStart, scheduledEnd, timezone: "Asia/Kolkata" },
      });
      expect(save.statusCode).toBe(200);
      const saved = save.json();
      expect(saved.mode).toBe("ai_scheduled");
      expect(saved.scheduledStart).toBe(scheduledStart);
      expect(saved.timezone).toBe("Asia/Kolkata");

      const get = await app.inject({ method: "GET", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: coordinatorCookie } });
      expect(get.json().mode).toBe("ai_scheduled");

      // A second save (switching back to manual) must upsert the same row, not create a second one.
      const revert = await app.inject({
        method: "PATCH", url: `/conversations/${target.id}/automation`, cookies: { pulseos_session: coordinatorCookie },
        payload: { mode: "manual" },
      });
      expect(revert.statusCode).toBe(200);
      expect(revert.json().scheduledStart).toBeNull();

      const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
      const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
      expect(eventTypes).toContain("conversation_automation_updated");
    });

    it("404s for a conversation that does not exist", async () => {
      const res = await app.inject({ method: "GET", url: "/conversations/00000000-0000-0000-0000-000000000000/automation", cookies: { pulseos_session: coordinatorCookie } });
      expect(res.statusCode).toBe(404);
    });
  });
});

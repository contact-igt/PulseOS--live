import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { conversations, messages } from "../../db/schema.js";
import { FixtureSummarizer } from "../../domain/conversation/summary/fixture-summarizer.js";
import { dueAfter } from "../../domain/conversation/summary/session-time.js";
import { getConversationSettings, processDueConversationSummaries, syncSessionTimelineEvent } from "../../domain/conversation/summary/conversation-session.service.js";

/**
 * Build what live traffic would have built by now for the seeded WhatsApp threads: the service-window anchor
 * (last patient message), one Timeline line per conversation session, and a summary — labelled FIXTURE, never AI.
 */
export async function seedConversationSessions(): Promise<void> {
  const threads = await db.select().from(conversations).where(eq(conversations.channel, "WHATSAPP"));
  for (const conv of threads) {
    const msgs = await db.select({ senderType: messages.senderType, sentAt: messages.sentAt }).from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.sentAt));
    if (msgs.length === 0) continue;
    const { idleMinutes } = await getConversationSettings(db, conv.tenantId);
    const lastPatient = [...msgs].reverse().find((m) => m.senderType === "patient");
    await db
      .update(conversations)
      .set({ summaryDueAt: dueAfter(msgs[msgs.length - 1]!.sentAt, idleMinutes), lastPatientInboundAt: lastPatient?.sentAt ?? null })
      .where(eq(conversations.id, conv.id));
    await syncSessionTimelineEvent(db, conv.tenantId, conv.id);
  }
  await processDueConversationSummaries(db, new Date(), new FixtureSummarizer(), { limit: 1000 });
}

import "dotenv/config";
import { buildApp } from "./app.js";
import { db } from "./db/client.js";
import { startJobRunner, type DueJob } from "./jobs/runner.js";
import { processDueConversationSummaries } from "./domain/conversation/summary/conversation-session.service.js";
import { processDueCallIntelligence } from "./domain/call/call-intelligence.service.js";
import { getTranscriber } from "./domain/call/transcriber.js";
import { deliverDueWebhooks } from "./domain/integration/outbound-webhook.service.js";
import { processDueNotifications } from "./domain/notification/notification.service.js";
import { RECONCILE_DEFAULT_INTERVAL_MS, reconcileJob } from "./domain/notification/reconcile.js";
import { syncDueAds } from "./domain/ads/ads-sync.service.js";
import { getSummarizer } from "./domain/conversation/summary/index.js";
import { encryptionStartupWarning } from "./domain/security/encryption.js";

const port = Number(process.env.PORT ?? 4000);

const app = await buildApp();
const encryptionWarning = encryptionStartupWarning();
if (encryptionWarning) app.log.error(encryptionWarning);

// Due-time work runs from the database, not from timers held in memory: summaries of idle conversations
// now; appointment reminders next. Set JOBS_DISABLED=true to turn the runner off (e.g. a second API
// instance that should only serve requests).
const jobs: DueJob[] = [
  { name: "conversation-summaries", run: (now) => processDueConversationSummaries(db, now, getSummarizer()) },
  { name: "call-intelligence", run: (now) => processDueCallIntelligence(db, now, { transcriberFor: (mode) => getTranscriber(mode), summarizer: getSummarizer() }) },
  { name: "notifications", run: (now) => processDueNotifications(db, now) },
  // Safety net: confirmed visits whose confirmation/reminders were never planned (e.g. the process died right after Confirm).
  reconcileJob(db, (msg, detail) => app.log.info({ detail }, msg), Number(process.env.NOTIFICATION_RECONCILE_INTERVAL_MS) || RECONCILE_DEFAULT_INTERVAL_MS),
  { name: "ads-sync", run: (now) => syncDueAds(db, now) },
  { name: "outbound-webhooks", run: (now) => deliverDueWebhooks(db, now) },
];
const stopJobs = process.env.JOBS_DISABLED === "true" ? null : startJobRunner(jobs, { log: (msg, detail) => app.log.error({ detail }, msg) });
app.addHook("onClose", async () => stopJobs?.());

app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`PulseOS API listening on http://localhost:${port}`);
});

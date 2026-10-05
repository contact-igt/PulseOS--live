import { and, asc, eq, notInArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { callIntelligence, calls, journeys, patients } from "../../db/schema.js";
import { addCallFeedback, logManualCall } from "../../domain/call/call.service.js";
import { processDueCallIntelligence } from "../../domain/call/call-intelligence.service.js";
import { getTranscriber } from "../../domain/call/transcriber.js";
import { FixtureSummarizer } from "../../domain/conversation/summary/fixture-summarizer.js";
import { persistInboundCall } from "../../domain/connector/call-webhook.service.js";
import { FIXTURE_RECORDING_REF } from "../../domain/call/recording.js";

const CATARACT_SCRIPT = [
  "Patient: Hello, I am calling about cataract surgery. My doctor said my right eye has a cataract.",
  "Hospital: Thank you for calling. We can arrange a consultation with our cataract surgeon. Do you have a day in mind?",
  "Patient: Do you have anything on Saturday morning? And what would the surgery cost roughly?",
  "Hospital: Saturday morning slots are available. The surgeon will explain the options and cost at the consultation.",
  "Patient: I will confirm after speaking with my family. Could you call me on Friday at 11?",
  "Hospital: Yes, we will call you on Friday at 11 AM.",
].join("\n");

// Hand-written demo wording, stored with mode FIXTURE so every screen labels it "Demo summary — not AI".
const CATARACT_DEMO_SUMMARY = {
  summary: "Patient enquired about cataract surgery for the right eye, asked about Saturday morning availability and a rough cost, and said they will confirm after discussing with family.",
  details: { patientIntent: "Cataract surgery enquiry (right eye)", serviceInterest: "Cataract", questions: ["Is Saturday morning available?", "What would the surgery cost roughly?"], agreedAction: "Hospital to call on Friday at 11 AM", nextAction: "Call Friday at 11:00 AM" },
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** An ACTIVE journey of this service: the webhook path attaches an incoming call to the patient's open journey. */
async function journeyFor(tenantId: string, specialtyKey: string, skip = 0) {
  const rows = await db
    .select({ journeyId: journeys.id, patientId: journeys.patientId, phone: patients.phone })
    .from(journeys)
    .innerJoin(patients, eq(journeys.patientId, patients.id))
    .where(and(eq(journeys.tenantId, tenantId), eq(journeys.specialtyKey, specialtyKey), notInArray(journeys.stage, ["completed", "lost"])))
    .orderBy(asc(journeys.createdAt));
  const row = rows[skip];
  if (!row) throw new Error(`seed: no ${specialtyKey} journey #${skip} for call demo data`);
  return row;
}

/**
 * Three realistic call stories on the Ophthalmology demo, written through the SAME code paths live traffic uses
 * (webhook ingest, the transcription/summary job, staff feedback, manual Log Call):
 *  1. A Cataract journey: an integrated IVR call with a (silent, fixture) recording, a transcript, a labelled demo
 *     summary and the coordinator's own feedback + callback.
 *  2. A Laser Vision Correction journey: a call a front-desk user logged by hand.
 *  3. A missed IVR call on another journey, with its callback Task waiting in My Work.
 */
export async function seedCallDemo(tenantId: string, ctx: { runoConnectorId: string; coordinator: { id: string; name: string; role: "PATIENT_COORDINATOR" }; frontDesk: { id: string; name: string; role: "FRONT_DESK" }; tag: string }) {
  // 1 — Cataract: IVR call → recording → transcript → summary → human feedback + callback.
  const cat = await journeyFor(tenantId, "CATARACT");
  await persistInboundCall(db, tenantId, ctx.runoConnectorId, {
    externalEventId: `demo-${ctx.tag}-ivr-cataract`, externalCallId: `demo-${ctx.tag}-ivr-cataract`, phone: cat.phone, direction: "inbound", status: "completed", durationSeconds: 278,
    recordingUrl: FIXTURE_RECORDING_REF, disposition: null, agentName: "Reception IVR", startedAt: minutesAgo(190), endedAt: minutesAgo(185), metadata: { fixtureTranscript: CATARACT_SCRIPT },
  });
  const [ivr] = await db.select({ id: calls.id }).from(calls).where(and(eq(calls.tenantId, tenantId), eq(calls.externalCallId, `demo-${ctx.tag}-ivr-cataract`)));
  await processDueCallIntelligence(db, new Date(), { transcriberFor: (mode) => getTranscriber(mode, {}), summarizer: new FixtureSummarizer() }, { onlyCallIds: [ivr!.id] });
  await db
    .update(callIntelligence)
    .set({ summary: CATARACT_DEMO_SUMMARY.summary, summaryDetails: CATARACT_DEMO_SUMMARY.details, summaryProvider: "fixture-demo", summaryMode: "FIXTURE" })
    .where(eq(callIntelligence.callId, ivr!.id));
  const feedback = await addCallFeedback(db, tenantId, ctx.coordinator, ivr!.id, {
    staffFeedback: "Patient will confirm after speaking with family.",
    outcomeKey: "discussing_with_family",
    callback: { dueAt: new Date(Date.now() + 20 * 3_600_000).toISOString(), note: "Call Friday 11:00 AM" },
  });
  if (!feedback.ok) throw new Error(`seed: call feedback failed (${feedback.reason})`);

  // 2 — Laser Vision Correction: an outgoing call the front desk logged by hand.
  const lvc = await journeyFor(tenantId, "LASER_VISION_CORRECTION");
  const manual = await logManualCall(db, tenantId, ctx.frontDesk, lvc.journeyId, {
    direction: "outbound", connected: true, occurredAt: minutesAgo(95).toISOString(), durationSeconds: 154,
    staffFeedback: "Called to confirm interest in LASIK screening. Asked for evening slots; wants to bring previous glasses prescription.",
    outcomeKey: "interested",
  });
  if (!manual.ok) throw new Error(`seed: manual call failed (${manual.reason})`);

  // 3 — A missed incoming call on a Squint journey: the callback Task is created by the webhook path.
  const missed = await journeyFor(tenantId, "SQUINT");
  await persistInboundCall(db, tenantId, ctx.runoConnectorId, {
    externalEventId: `demo-${ctx.tag}-ivr-missed`, externalCallId: `demo-${ctx.tag}-ivr-missed`, phone: missed.phone, direction: "inbound", status: "missed", durationSeconds: null,
    recordingUrl: null, disposition: null, agentName: null, startedAt: minutesAgo(40), endedAt: minutesAgo(40), metadata: {},
  });
}

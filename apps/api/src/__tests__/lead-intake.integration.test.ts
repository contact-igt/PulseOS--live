import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, calls, followUpTypes, marketingCampaigns, journeys, leadSources, patients, scheduleResources, specialtyTemplates, tasks, timelineEvents } from "../db/schema.js";
import { onAppointmentEvent, type AppointmentDomainEvent } from "../domain/appointment/appointment-events.js";
import { zonedWallTime } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const IST = "Asia/Kolkata";
/** Offset-less hospital wall time, exactly what the browser sends: "YYYY-MM-DDTHH:mm". */
const wall = (days: number, hh: number, mm = 0) => `${new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", { timeZone: IST })}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
const instant = (days: number, hh: number, mm = 0) => zonedWallTime(wall(days, hh, mm).slice(0, 10), hh, mm, IST);

describe.skipIf(!DEMO_PASSWORD)("Add Lead — one transactional intake (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let doctorA: string;
  let foreignDoctor: string;
  let n = 0;
  const events: AppointmentDomainEvent[] = [];
  const phone = () => `+9197${String(80000000 + ++n * 53).padStart(8, "0")}`;
  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const post = (payload: object, tt: TestTenant = t, role: Role = "PATIENT_COORDINATOR") => app.inject({ method: "POST", url: "/leads", cookies: as(tt, role), payload });
  const base = (over: object = {}) => ({ name: "Intake Test", phone: phone(), specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "instagram", channel: "INSTAGRAM_DM", ...over });
  const countFor = async (ph: string) => {
    const p = await db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, ph)));
    return { patients: p.length, journeys: p.length ? (await db.select({ id: journeys.id }).from(journeys).where(eq(journeys.patientId, p[0]!.id))).length : 0, id: p[0]?.id };
  };

  beforeAll(async () => {
    app = await buildApp();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    doctorA = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, t.tenantId), eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!))))[0]!.id;
    foreignDoctor = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.tenantId, other.tenantId)))[0]!.id;
    onAppointmentEvent((e) => void events.push(e));
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("Instagram → Callback tomorrow 11:00: patient, journey, ONE labelled callback task at 11:00 hospital time, honest manual timeline, source kept apart from channel", async () => {
    const ph = phone();
    const res = await post(base({ phone: ph, outcomeKey: "needs_callback", nextStep: { kind: "callback", dueAt: wall(1, 11), note: "Wants evening slot" } }));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { patientId: string; journeyId: string; followUpTaskId: string; appointmentId?: string };
    expect(out.followUpTaskId).toBeTruthy();
    expect(out.appointmentId).toBeUndefined();

    const [task] = await db.select().from(tasks).where(eq(tasks.journeyId, out.journeyId));
    expect(task!.dueAt.toISOString()).toBe(instant(1, 11).toISOString());
    expect(task!.type).toBe("CALLBACK");
    expect(task!.followUpTypeId).not.toBeNull();
    expect(task!.notes).toBe("Wants evening slot");
    expect(await db.select().from(tasks).where(eq(tasks.journeyId, out.journeyId))).toHaveLength(1);

    const [fut] = await db.select().from(followUpTypes).where(eq(followUpTypes.id, task!.followUpTypeId!));
    expect(fut!.key).toBe("callback");

    const [j] = await db.select().from(journeys).where(eq(journeys.id, out.journeyId));
    const [src] = await db.select().from(leadSources).where(eq(leadSources.id, j!.sourceId!));
    expect(src!.key).toBe("instagram"); // SOURCE: where the patient came from
    expect(j!.stage).toBe("contacted"); // the outcome moved it
    expect(j!.lastOutcomeId).not.toBeNull();

    const tl = await db.select().from(timelineEvents).where(eq(timelineEvents.patientId, out.patientId));
    const created = tl.find((e) => e.eventType === "lead_created")!;
    expect(created.channel).toBe("INSTAGRAM_DM"); // CHANNEL: how this contact happened
    expect(created.description).toMatch(/Instagram DM manually captured/);
    expect(tl.map((e) => e.eventType)).toEqual(expect.arrayContaining(["patient_created", "lead_created", "outcome_logged", "task_created"]));
    // Honest: no provider message was fabricated.
    expect(tl.some((e) => /message/i.test(e.eventType))).toBe(false);
  });

  it("Phone → Appointment: books through the M6 engine (hospital time, doctor, branch), no task, and publishes the booked event only after commit", async () => {
    const before = events.length;
    const res = await post(base({ channel: "MANUAL_CALL", sourceKey: "google", outcomeKey: "interested", nextStep: { kind: "appointment", scheduledAt: wall(4, 10, 30), doctorId: doctorA, branchId: t.branchId, note: "Cataract check" } }));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { journeyId: string; appointmentId: string; followUpTaskId?: string };
    expect(out.followUpTaskId).toBeUndefined();
    const [a] = await db.select().from(appointments).where(eq(appointments.id, out.appointmentId));
    expect(a!.scheduledAt.toISOString()).toBe(instant(4, 10, 30).toISOString());
    expect(a!.status).toBe("scheduled");
    expect(a!.reason).toBe("Cataract check");
    expect(a!.branchId).toBe(t.branchId);
    expect(await db.select().from(tasks).where(eq(tasks.journeyId, out.journeyId))).toHaveLength(0);
    expect(events.slice(before).filter((e) => e.type === "appointment.booked")).toHaveLength(1);
    const tl = await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, out.journeyId));
    expect(tl.find((e) => e.eventType === "lead_created")!.description).toMatch(/phone call recorded manually/i);
    expect(tl.map((e) => e.eventType)).toEqual(expect.arrayContaining(["appointment_created"]));
  });

  it("a past appointment time is refused with a structured error and NOTHING is saved (no patient, journey, task)", async () => {
    const ph = phone();
    const before = events.length;
    const res = await post(base({ phone: ph, nextStep: { kind: "appointment", scheduledAt: wall(-1, 10), doctorId: doctorA, branchId: t.branchId } }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "appointment_time_in_past", step: "appointment" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
    expect(events.length).toBe(before);
  });

  it("a doctor's taken minute: 409 + nothing saved; choosing another time then succeeds, creating the patient exactly once", async () => {
    const taken = wall(6, 15, 0);
    expect((await post(base({ nextStep: { kind: "appointment", scheduledAt: taken, doctorId: doctorA, branchId: t.branchId } }))).statusCode).toBe(201);
    const ph = phone();
    const clash = await post(base({ phone: ph, nextStep: { kind: "appointment", scheduledAt: taken, doctorId: doctorA, branchId: t.branchId } }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: "resource_unavailable", step: "appointment" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
    const retry = await post(base({ phone: ph, nextStep: { kind: "appointment", scheduledAt: wall(6, 15, 30), doctorId: doctorA, branchId: t.branchId } }));
    expect(retry.statusCode, retry.body).toBe(201);
    expect(await countFor(ph)).toMatchObject({ patients: 1, journeys: 1 });
  });

  it("another hospital's doctor or an unknown branch is refused, with nothing saved", async () => {
    const ph = phone();
    const foreign = await post(base({ phone: ph, nextStep: { kind: "appointment", scheduledAt: wall(7, 11), doctorId: foreignDoctor, branchId: t.branchId } }));
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ error: "doctor_not_found", step: "appointment" });
    const badBranch = await post(base({ phone: ph, nextStep: { kind: "appointment", scheduledAt: wall(7, 12), doctorId: doctorA, branchId: other.branchId } }));
    expect(badBranch.json()).toMatchObject({ error: "branch_not_found", step: "appointment" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
  });

  it("an outcome that requires a follow-up cannot be saved without the task details", async () => {
    const ph = phone();
    for (const nextStep of [undefined, { kind: "none" }, { kind: "appointment", scheduledAt: wall(8, 10), doctorId: doctorA, branchId: t.branchId }]) {
      const res = await post(base({ phone: ph, outcomeKey: "needs_callback", ...(nextStep ? { nextStep } : {}) }));
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "follow_up_required", step: "outcome" });
    }
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
  });

  it("outcome rules: an appointment needs an outcome that allows one; a lost outcome takes no next step; unknown outcome refused", async () => {
    const ph = phone();
    const noAppt = await post(base({ phone: ph, outcomeKey: "price_enquiry", nextStep: { kind: "appointment", scheduledAt: wall(9, 10), doctorId: doctorA, branchId: t.branchId } }));
    expect(noAppt.json()).toMatchObject({ error: "outcome_disallows_appointment", step: "outcome" });
    const lost = await post(base({ phone: ph, outcomeKey: "not_interested", outcomeReason: "Too far", nextStep: { kind: "callback", dueAt: wall(9, 10) } }));
    expect(lost.json()).toMatchObject({ error: "outcome_closes_journey", step: "outcome" });
    const unknown = await post(base({ phone: ph, outcomeKey: "nope" }));
    expect(unknown.json()).toMatchObject({ error: "outcome_not_found", step: "outcome" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
    // …and a lost outcome with no next step is fine, with its reason on the timeline.
    const ok = await post(base({ phone: ph, outcomeKey: "not_interested", outcomeReason: "Too far", nextStep: { kind: "none" } }));
    expect(ok.statusCode, ok.body).toBe(201);
    const [j] = await db.select().from(journeys).where(eq(journeys.id, (ok.json() as { journeyId: string }).journeyId));
    expect(j!.stage).toBe("lost");
  });

  it("No follow-up creates no task and no appointment; General follow-up creates one General Follow-up task", async () => {
    const none = await post(base({ nextStep: { kind: "none" } }));
    expect(none.statusCode).toBe(201);
    const noneJ = (none.json() as { journeyId: string }).journeyId;
    expect(await db.select().from(tasks).where(eq(tasks.journeyId, noneJ))).toHaveLength(0);
    expect(await db.select().from(appointments).where(eq(appointments.journeyId, noneJ))).toHaveLength(0);

    const gen = await post(base({ nextStep: { kind: "follow_up", dueAt: wall(2, 10) } }));
    expect(gen.statusCode).toBe(201);
    const [task] = await db.select().from(tasks).where(eq(tasks.journeyId, (gen.json() as { journeyId: string }).journeyId));
    const [fut] = await db.select().from(followUpTypes).where(eq(followUpTypes.id, task!.followUpTypeId!));
    expect(fut!.key).toBe("general_followup");
  });

  it("a follow-up that cannot be created (past time, unknown assignee) refuses the whole lead — nothing half-saved", async () => {
    const ph = phone();
    const past = await post(base({ phone: ph, nextStep: { kind: "callback", dueAt: wall(-1, 10) } }));
    expect(past.statusCode).toBe(422);
    expect(past.json()).toMatchObject({ error: "due_in_past", step: "follow_up" });
    const badOwner = await post(base({ phone: ph, nextStep: { kind: "callback", dueAt: wall(2, 10), assignedTo: other.userIds.PATIENT_COORDINATOR } }));
    expect(badOwner.json()).toMatchObject({ error: "assignee_invalid", step: "follow_up" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
  });

  it("Phone with call details records a manual Call (M4) — direction, connected, duration — and still no fabricated provider data", async () => {
    const res = await post(base({ channel: "MANUAL_CALL", call: { direction: "inbound", connected: true, durationSeconds: 95, note: "Asked about LASIK cost" }, nextStep: { kind: "none" } }));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { journeyId: string; callId: string };
    const [c] = await db.select().from(calls).where(eq(calls.id, out.callId));
    expect(c).toMatchObject({ origin: "MANUAL", direction: "inbound", durationSeconds: 95, staffFeedback: "Asked about LASIK cost" });
    // Call details only make sense for a phone enquiry.
    const wrong = await post(base({ channel: "WALK_IN", call: { direction: "inbound", connected: true } }));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().fields).toContain("call");
  });

  it("an existing patient (same phone) gets a NEW journey, not a duplicate patient, and keeps its first source", async () => {
    const ph = phone();
    expect((await post(base({ phone: ph, sourceKey: "google" }))).statusCode).toBe(201);
    expect((await post(base({ phone: ph, sourceKey: "walk_in", channel: "WALK_IN" }))).statusCode).toBe(201);
    expect(await countFor(ph)).toMatchObject({ patients: 1, journeys: 2 });
  });

  it("tenant comes from the session (a smuggled tenantId is ignored); Doctor cannot add leads; another hospital's doctor is not usable", async () => {
    const ph = phone();
    const res = await post({ ...base({ phone: ph }), tenantId: other.tenantId });
    expect(res.statusCode).toBe(201);
    const [p] = await db.select().from(patients).where(eq(patients.phoneE164, ph));
    expect(p!.tenantId).toBe(t.tenantId);
    expect((await post(base(), t, "DOCTOR")).statusCode).toBe(403);
  });

  it("required CRM fields are still enforced server-side, and nothing is saved without them", async () => {
    await db.insert(specialtyTemplates).values({ tenantId: t.tenantId, key: "CATARACT", displayName: "Cataract", defaultJourneyType: "Cataract" }).onConflictDoNothing();
    const mk = await app.inject({ method: "POST", url: "/crm/fields", cookies: as(t, "HOSPITAL_ADMIN"), payload: { specialtyKey: "CATARACT", key: "intake_eye_side", label: "Eye side", fieldType: "TEXT", required: true, placements: ["add_lead"] } });
    expect(mk.statusCode, mk.body).toBe(201);
    const ph = phone();
    const res = await post(base({ phone: ph, customFieldValues: {} }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "missing_required_fields" });
    expect(await countFor(ph)).toMatchObject({ patients: 0, journeys: 0 });
    expect((await post(base({ phone: ph, customFieldValues: { intake_eye_side: "Left" } }))).statusCode).toBe(201);
    await app.inject({ method: "PATCH", url: `/crm/fields/${(mk.json() as { id: string }).id}`, cookies: as(t, "HOSPITAL_ADMIN"), payload: { archived: true } });
  });

  it("an unknown channel (IVR cannot be typed in by hand) is refused", async () => {
    const res = await post(base({ channel: "IVR_CALL" }));
    expect([400, 422]).toContain(res.statusCode);
  });

  it("another hospital's owner, branch or campaign can never be attached to a lead (nothing saved)", async () => {
    const [foreignCampaign] = await db.insert(marketingCampaigns).values({ tenantId: other.tenantId, name: "Foreign campaign", source: "google", startDate: new Date() }).returning({ id: marketingCampaigns.id });
    for (const [field, body] of [
      ["ownerId", { ownerId: other.userIds.PATIENT_COORDINATOR }],
      ["branchId", { branchId: other.branchId }],
      ["campaignId", { campaignId: foreignCampaign!.id }],
    ] as const) {
      const ph = phone();
      const res = await post(base({ phone: ph, ...body }));
      expect(res.statusCode, field).toBe(422);
      expect(res.json().fields, field).toContain(field);
      expect(await countFor(ph), field).toMatchObject({ patients: 0, journeys: 0 });
    }
    // The same references from this hospital are fine.
    const ok = await post(base({ ownerId: t.userIds.PATIENT_COORDINATOR, branchId: t.branchId }));
    expect(ok.statusCode, ok.body).toBe(201);
    await db.delete(marketingCampaigns).where(eq(marketingCampaigns.tenantId, other.tenantId));
  });

  it("a connected phone call marks the lead as contacted even without an outcome; an unanswered call does not", async () => {
    const connected = await post(base({ channel: "MANUAL_CALL", call: { direction: "inbound", connected: true, durationSeconds: 40 }, nextStep: { kind: "none" } }));
    expect(connected.statusCode, connected.body).toBe(201);
    const [j1] = await db.select().from(journeys).where(eq(journeys.id, (connected.json() as { journeyId: string }).journeyId));
    expect(j1!.stage).toBe("contacted");
    expect(j1!.contactedAt).not.toBeNull();
    const missed = await post(base({ channel: "MANUAL_CALL", call: { direction: "outbound", connected: false }, nextStep: { kind: "none" } }));
    const [j2] = await db.select().from(journeys).where(eq(journeys.id, (missed.json() as { journeyId: string }).journeyId));
    expect(j2!.stage).toBe("enquiry");
    expect(j2!.contactedAt).toBeNull();
  });
});

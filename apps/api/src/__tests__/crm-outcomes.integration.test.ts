import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, like, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { crmOutcomes, customFieldDefinitions, customFieldValues, journeys, tasks, timelineEvents } from "../db/schema.js";
import { purgePatientData } from "./helpers/purge.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, CrmFieldVm, CrmOutcomeVm, JourneyDetailVm, LogInteractionResult, TaskRow } from "@pulseos/types";

// Configurable outcomes: tenants choose sub-status / disposition / follow-up wording and three simple
// rules (requires follow-up, offers an appointment, asks a reason). The canonical stages never change:
// an outcome only maps to CONTACTED or LOST, and a Journey only ever moves forward.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const PREFIX = "t_out_";

async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe.skipIf(!DEMO_PASSWORD)("CRM outcomes (integration)", () => {
  let app: FastifyInstance;
  let admin: string;
  let coordinator: string;
  let doctor: string;
  let gynAdmin: string;
  let branchId: string;
  const outcomeIds: string[] = [];
  const fieldIds: string[] = [];
  const patientIds: string[] = [];

  const call = (cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined, cookies: { pulseos_session: cookie } });
  const outcomes = async (cookie = coordinator, qs = "") => (await call(cookie, "GET", `/crm/outcomes${qs}`)).json() as CrmOutcomeVm[];
  async function newJourney(): Promise<CreateLeadResult> {
    const res = await call(admin, "POST", "/leads", { name: "Outcome Patient", phone: phone(), specialtyKey: "CATARACT", branchId, source: "walk_in", journeyType: "Cataract" });
    expect(res.statusCode).toBe(201);
    const made = res.json() as CreateLeadResult;
    patientIds.push(made.patientId);
    return made;
  }
  const log = (cookie: string, journeyId: string, body: Record<string, unknown>) => call(cookie, "POST", `/journeys/${journeyId}/interactions`, body);
  const detail = async (journeyId: string) => (await call(admin, "GET", `/journeys/${journeyId}`)).json() as JourneyDetailVm;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await login(app, "eye.admin@pulseos.local");
    coordinator = await login(app, "eye.coordinator@pulseos.local");
    doctor = await login(app, "eye.doctor@pulseos.local");
    gynAdmin = await login(app, "gyn.admin@pulseos.local");
    branchId = ((await call(admin, "GET", "/lookups")).json() as { branches: { id: string }[] }).branches[0].id;
  });

  afterAll(async () => {
    await purgePatientData(db, patientIds);
    const created = await db.select({ id: crmOutcomes.id }).from(crmOutcomes).where(like(crmOutcomes.key, `${PREFIX}%`));
    const ids = [...new Set([...outcomeIds, ...created.map((c) => c.id)])];
    if (ids.length) {
      await db.update(journeys).set({ lastOutcomeId: null }).where(inArray(journeys.lastOutcomeId, ids));
      await db.delete(crmOutcomes).where(inArray(crmOutcomes.id, ids));
    }
    if (fieldIds.length) {
      await db.delete(customFieldValues).where(inArray(customFieldValues.fieldDefinitionId, fieldIds));
      await db.delete(customFieldDefinitions).where(inArray(customFieldDefinitions.id, fieldIds));
    }
    await app.close();
    await queryClient.end();
  });

  it("every tenant has the standard outcomes; any task-managing role can read the active ones", async () => {
    const eye = await outcomes();
    expect(eye.map((o) => o.key)).toEqual(expect.arrayContaining(["interested", "needs_callback", "price_enquiry", "needs_reports", "discussing_with_family", "appointment_booked", "no_answer", "not_interested"]));
    const callback = eye.find((o) => o.key === "needs_callback")!;
    expect(callback).toMatchObject({ stage: "contacted", requiresFollowUp: true, followUpType: "CALLBACK" });
    expect(eye.find((o) => o.key === "appointment_booked")).toMatchObject({ allowsAppointment: true, requiresFollowUp: false });
    expect(eye.find((o) => o.key === "not_interested")).toMatchObject({ stage: "lost", asksReason: true });
    expect((await outcomes(gynAdmin)).length).toBeGreaterThan(0);
    expect((await call(doctor, "GET", "/crm/outcomes")).statusCode).toBe(403); // doctors do not log follow-ups
  });

  it("only an admin configures outcomes; stages are limited to contacted or lost", async () => {
    const body = { key: `${PREFIX}reports`, label: "Waiting for reports", stage: "contacted", requiresFollowUp: true };
    expect((await call(coordinator, "POST", "/crm/outcomes", body)).statusCode).toBe(403);
    for (const stage of ["booked", "completed", "enquiry"]) expect((await call(admin, "POST", "/crm/outcomes", { ...body, key: `${PREFIX}x${stage}`, stage })).statusCode, stage).toBe(400);
    const created = await call(admin, "POST", "/crm/outcomes", body);
    expect(created.statusCode).toBe(201);
    const o = created.json() as CrmOutcomeVm;
    outcomeIds.push(o.id);
    expect(o).toMatchObject({ key: `${PREFIX}reports`, label: "Waiting for reports", stage: "contacted", requiresFollowUp: true, allowsAppointment: false, asksReason: false, archived: false, followUpType: "FOLLOW_UP" });
    expect((await call(admin, "POST", "/crm/outcomes", body)).statusCode).toBe(409);
    expect((await call(admin, "POST", "/crm/outcomes", { ...body, key: "Bad Key" })).statusCode).toBe(400);
    const edited = await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { label: "Awaiting reports", requiresFollowUp: false, asksReason: true });
    expect(edited.json()).toMatchObject({ label: "Awaiting reports", requiresFollowUp: false, asksReason: true });
    expect((await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { key: "renamed" })).statusCode).toBe(400);
  });

  it("reorders, and archived outcomes disappear from the picker but stay in the admin list", async () => {
    const a = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}a`, label: "A", stage: "contacted" })).json() as CrmOutcomeVm;
    const b = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}b`, label: "B", stage: "contacted" })).json() as CrmOutcomeVm;
    outcomeIds.push(a.id, b.id);
    expect((await call(admin, "POST", "/crm/outcomes/reorder", { orderedIds: [b.id, a.id] })).statusCode).toBe(200);
    const order = (await outcomes(admin)).filter((o) => [a.id, b.id].includes(o.id)).map((o) => o.id);
    expect(order).toEqual([b.id, a.id]);
    await call(admin, "PATCH", `/crm/outcomes/${a.id}`, { archived: true });
    expect((await outcomes(coordinator)).map((o) => o.id)).not.toContain(a.id);
    expect((await outcomes(admin, "?includeArchived=true")).find((o) => o.id === a.id)?.archived).toBe(true);
    expect((await log(coordinator, (await newJourney()).journeyId, { outcomeKey: `${PREFIX}a` })).statusCode).toBe(400); // archived -> unknown outcome
  });

  it("logging an outcome that requires a follow-up needs a future date, then creates the Task", async () => {
    const j = await newJourney();
    const missing = await log(coordinator, j.journeyId, { outcomeKey: "needs_callback" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("follow_up_required");
    expect((await log(coordinator, j.journeyId, { outcomeKey: "needs_callback", followUpAt: inHours(-2) })).json().error).toBe("follow_up_in_past");

    const due = inHours(26);
    const ok = await log(coordinator, j.journeyId, { outcomeKey: "needs_callback", note: "Asked to call after 5pm", followUpAt: due });
    expect(ok.statusCode).toBe(201);
    const result = ok.json() as LogInteractionResult;
    expect(result).toMatchObject({ journeyId: j.journeyId, stage: "contacted", stageChanged: true, outcome: { key: "needs_callback" } });
    expect(result.followUpTaskId).toBeTruthy();

    const task = ((await call(coordinator, "GET", `/tasks?patientId=${j.patientId}`)).json() as TaskRow[]).find((t) => t.id === result.followUpTaskId)!;
    expect(task).toMatchObject({ type: "CALLBACK", status: "pending", journeyId: j.journeyId });
    expect(new Date(task.dueAt).toISOString()).toBe(new Date(due).toISOString());
    expect(task.notes).toContain("Asked to call after 5pm");

    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, j.journeyId));
    const logged = events.find((e) => e.eventType === "outcome_logged");
    expect(logged?.title).toBe("Outcome: Needs callback");
    expect(logged?.description).toContain("Asked to call after 5pm");

    const d = await detail(j.journeyId);
    expect(d.journey.stage).toBe("contacted");
    expect(d.journey.lastOutcome).toMatchObject({ label: "Needs callback" });
  });

  it("an outcome that offers an appointment records it without booking anything, and a follow-up is optional", async () => {
    const j = await newJourney();
    const res = await log(coordinator, j.journeyId, { outcomeKey: "appointment_booked" });
    expect(res.statusCode).toBe(201);
    expect((res.json() as LogInteractionResult).followUpTaskId).toBeNull();
    expect((await call(coordinator, "GET", `/appointments?journeyId=${j.journeyId}`)).json()).toEqual([]);
    expect((res.json() as LogInteractionResult).outcome.allowsAppointment).toBe(true);
  });

  it("'Not interested' asks for a reason and closes an early Journey as lost; later Journeys keep their stage", async () => {
    const early = await newJourney();
    const res = await log(coordinator, early.journeyId, { outcomeKey: "not_interested", reason: "Going to another hospital" });
    expect((res.json() as LogInteractionResult)).toMatchObject({ stage: "lost", stageChanged: true });
    const ev = (await db.select().from(timelineEvents).where(eq(timelineEvents.journeyId, early.journeyId))).find((e) => e.eventType === "outcome_logged");
    expect(ev?.description).toContain("Going to another hospital");

    const later = await newJourney();
    await db.update(journeys).set({ stage: "booked" }).where(eq(journeys.id, later.journeyId));
    const kept = await log(coordinator, later.journeyId, { outcomeKey: "not_interested" });
    expect(kept.json()).toMatchObject({ stage: "booked", stageChanged: false }); // never regresses a booked Journey
  });

  it("a Journey only moves forward: contacted stays contacted, lost is not reopened", async () => {
    const j = await newJourney();
    await log(coordinator, j.journeyId, { outcomeKey: "interested" });
    expect((await detail(j.journeyId)).journey.stage).toBe("contacted");
    expect((await log(coordinator, j.journeyId, { outcomeKey: "price_enquiry" })).json()).toMatchObject({ stage: "contacted", stageChanged: false });
    await log(coordinator, j.journeyId, { outcomeKey: "not_interested" });
    expect((await log(coordinator, j.journeyId, { outcomeKey: "interested" })).json()).toMatchObject({ stage: "lost", stageChanged: false });
  });

  it("completes the task it was logged from, only if it belongs to that Journey and is still open", async () => {
    const j = await newJourney();
    const other = await newJourney();
    const mk = async (journeyId: string, patientId: string) =>
      ((await call(admin, "POST", "/tasks", { patientId, journeyId, type: "CALLBACK", dueAt: inHours(2) })).json() as TaskRow).id;
    const taskId = await mk(j.journeyId, j.patientId);
    const foreignTask = await mk(other.journeyId, other.patientId);
    expect((await log(coordinator, j.journeyId, { outcomeKey: "interested", taskId: foreignTask })).statusCode).toBe(404);
    const res = await log(coordinator, j.journeyId, { outcomeKey: "interested", taskId });
    expect((res.json() as LogInteractionResult).completedTaskId).toBe(taskId);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row?.status).toBe("completed");
    expect((await log(coordinator, j.journeyId, { outcomeKey: "interested", taskId })).statusCode).toBe(409); // already done
  });

  it("captures fields placed on 'follow-up outcome' (required ones enforced) and shows them on the Journey", async () => {
    const mk = await call(admin, "POST", "/crm/fields", { specialtyKey: "CATARACT", key: `${PREFIX}budget`, label: "Stated budget", fieldType: "NUMBER", required: true, placements: ["followup_outcome", "journey_detail"] });
    expect(mk.statusCode).toBe(201);
    fieldIds.push((mk.json() as CrmFieldVm).id);
    const j = await newJourney();
    const missing = await log(coordinator, j.journeyId, { outcomeKey: "price_enquiry" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: "missing_required_fields", fields: [`${PREFIX}budget`] });
    expect((await log(coordinator, j.journeyId, { outcomeKey: "price_enquiry", fieldValues: { [`${PREFIX}budget`]: "lots" } })).statusCode).toBe(422);
    expect((await log(coordinator, j.journeyId, { outcomeKey: "price_enquiry", fieldValues: { [`${PREFIX}budget`]: 45000 } })).statusCode).toBe(201);
    expect((await detail(j.journeyId)).customFields.find((f) => f.label === "Stated budget")?.value).toBe("45000");
    // A later answer replaces the earlier one.
    await log(coordinator, j.journeyId, { outcomeKey: "price_enquiry", fieldValues: { [`${PREFIX}budget`]: 60000 } });
    expect((await detail(j.journeyId)).customFields.filter((f) => f.label === "Stated budget").map((f) => f.value)).toEqual(["60000"]);
    await call(admin, "PATCH", `/crm/fields/${fieldIds[0]}`, { archived: true }); // keep later tests independent
  });

  it("is tenant-isolated and permission-gated", async () => {
    const j = await newJourney();
    expect((await log(gynAdmin, j.journeyId, { outcomeKey: "interested" })).statusCode).toBe(404); // another hospital's Journey
    expect((await log(doctor, j.journeyId, { outcomeKey: "interested" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/journeys/${j.journeyId}/interactions`, payload: { outcomeKey: "interested" } })).statusCode).toBe(401);
    // Another tenant's outcome key does not exist for this tenant.
    const mine = (await call(gynAdmin, "POST", "/crm/outcomes", { key: `${PREFIX}gyn_only`, label: "Gyn only", stage: "contacted" })).json() as CrmOutcomeVm;
    outcomeIds.push(mine.id);
    expect((await log(coordinator, j.journeyId, { outcomeKey: `${PREFIX}gyn_only` })).statusCode).toBe(400);
    expect((await call(admin, "PATCH", `/crm/outcomes/${mine.id}`, { label: "Hacked" })).statusCode).toBe(404);
    expect((await outcomes(admin, "?includeArchived=true")).map((o) => o.key)).not.toContain(`${PREFIX}gyn_only`);
    expect((await call(admin, "GET", "/crm/outcomes?includeArchived=true")).statusCode).toBe(200);
    expect((await log(coordinator, "not-a-uuid", { outcomeKey: "interested" })).statusCode).toBe(404);
  });

  describe("system stages are PulseOS's, outcomes are the hospital's", () => {
    it("the canonical stage list is exactly the database's stage enum, in lifecycle order", async () => {
      const { JOURNEY_STAGES } = await import("@pulseos/types");
      const { journeyStageEnum } = await import("../db/schema.js");
      expect([...JOURNEY_STAGES]).toEqual([...journeyStageEnum.enumValues]);
    });

    it("a hospital cannot move an outcome onto a system stage it does not own, or invent stage values", async () => {
      const o = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}stagecheck`, label: "Stage check", stage: "contacted" })).json() as CrmOutcomeVm;
      outcomeIds.push(o.id);
      for (const stage of ["enquiry", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "made_up"]) {
        expect((await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { stage })).statusCode, stage).toBe(400);
      }
      expect((await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { stage: "lost" })).statusCode).toBe(200); // never used: free to belong to the one other stage
      expect((await outcomes(admin, "?includeArchived=true")).find((x) => x.id === o.id)!.stage).toBe("lost");
    });

    it("an outcome already recorded on a journey keeps its stage (409); archive it and add a new one instead", async () => {
      const o = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}inuse`, label: "In use", stage: "contacted" })).json() as CrmOutcomeVm;
      outcomeIds.push(o.id);
      const { journeyId } = await newJourney();
      expect((await log(coordinator, journeyId, { outcomeKey: o.key })).statusCode).toBe(201);
      const res = await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { stage: "lost" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "outcome_in_use" });
      expect((await outcomes(admin, "?includeArchived=true")).find((x) => x.id === o.id)!.stage).toBe("contacted"); // history reads as it did
      expect((await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { label: "In use (renamed)", stage: "contacted" })).statusCode).toBe(200); // same stage, new words: fine
    });

    it("reordering inside one stage leaves the other stage alone — even when the two stages' sort orders interleave", async () => {
      const mk = async (key: string, stage: "contacted" | "lost") => {
        const r = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}${key}`, label: key.toUpperCase(), stage })).json() as CrmOutcomeVm;
        outcomeIds.push(r.id);
        return r;
      };
      // Created alternately, so their sort slots interleave: c1 < l1 < c2 < l2.
      const c1 = await mk("ord_c1", "contacted");
      const l1 = await mk("ord_l1", "lost");
      const c2 = await mk("ord_c2", "contacted");
      const l2 = await mk("ord_l2", "lost");
      const all = async () => (await outcomes(admin, "?includeArchived=true")).filter((x) => x.key.startsWith(`${PREFIX}ord_`));
      const orderOf = async (stage: string) => (await all()).filter((x) => x.stage === stage).sort((a, b) => a.sortOrder - b.sortOrder).map((x) => x.key);
      const slotsBefore = Object.fromEntries((await all()).map((x) => [x.key, x.sortOrder]));
      expect(await orderOf("contacted")).toEqual([c1.key, c2.key]);
      expect((await call(admin, "POST", "/crm/outcomes/reorder", { orderedIds: [c2.id, c1.id] })).statusCode).toBe(200);
      expect(await orderOf("contacted")).toEqual([c2.key, c1.key]);
      const after = Object.fromEntries((await all()).map((x) => [x.key, x.sortOrder]));
      expect(after[l1.key]).toBe(slotsBefore[l1.key]); // the other stage's rows did not move at all
      expect(after[l2.key]).toBe(slotsBefore[l2.key]);
      // The two contacted rows traded their own slots.
      expect([after[c2.key], after[c1.key]]).toEqual([slotsBefore[c1.key], slotsBefore[c2.key]]);
    });

    it("a reorder that mixes stages is refused, and another hospital's ids are refused", async () => {
      const c = (await outcomes(admin, "?includeArchived=true")).find((x) => x.stage === "contacted")!;
      const l = (await outcomes(admin, "?includeArchived=true")).find((x) => x.stage === "lost")!;
      expect((await call(admin, "POST", "/crm/outcomes/reorder", { orderedIds: [c.id, l.id] })).statusCode).toBe(400);
      const foreign = (await outcomes(gynAdmin, "?includeArchived=true"))[0]!;
      expect((await call(admin, "POST", "/crm/outcomes/reorder", { orderedIds: [c.id, foreign.id] })).statusCode).toBe(400);
    });

    it("an archived outcome stays readable on the journeys that recorded it, and in the admin list; it only leaves the picker", async () => {
      const o = (await call(admin, "POST", "/crm/outcomes", { key: `${PREFIX}arch_hist`, label: "Historic wording", stage: "contacted" })).json() as CrmOutcomeVm;
      outcomeIds.push(o.id);
      const { journeyId } = await newJourney();
      expect((await log(coordinator, journeyId, { outcomeKey: o.key })).statusCode).toBe(201);
      expect((await call(admin, "PATCH", `/crm/outcomes/${o.id}`, { archived: true })).statusCode).toBe(200);
      expect((await detail(journeyId)).journey.lastOutcome?.label).toBe("Historic wording"); // history keeps its words
      expect((await outcomes(admin, "?includeArchived=true")).find((x) => x.id === o.id)).toMatchObject({ archived: true, label: "Historic wording" });
      expect((await outcomes(coordinator)).some((x) => x.id === o.id)).toBe(false); // not offered for new entries
      expect((await log(coordinator, journeyId, { outcomeKey: o.key })).statusCode).toBeGreaterThanOrEqual(400); // and cannot be logged any more
    });
  });
});

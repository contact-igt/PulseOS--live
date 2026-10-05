import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import {
  appointments,
  campaignTouchpoints,
  customFieldDefinitions,
  customFieldValues,
  journeys,
  patients,
  revenueEvents,
  tasks,
  timelineEvents,
  treatmentOpportunities,
} from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, JourneyDetailVm, LeadRow, Lookups, SessionUser, TaskRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const RUN = Date.now();

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

async function sessionUser(app: FastifyInstance, cookie: string): Promise<SessionUser> {
  const res = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie } });
  return (res.json() as { user: SessionUser }).user;
}

function uniquePhone(): string {
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

describe.skipIf(!DEMO_PASSWORD)("journey detail + owner allocation (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let coordinatorCookie: string;
  let doctorCookie: string;
  let frontdeskCookie: string;
  let gynAdminCookie: string;
  let admin: SessionUser;
  let coordinator: SessionUser;
  let doctor: SessionUser;
  let frontdesk: SessionUser;
  let gynAdmin: SessionUser;
  let gynDoctor: SessionUser;

  let branchId: string;
  let campaign: { id: string; name: string };

  let patientId: string;
  let journeyId: string; // fully populated fixture journey (eye tenant)
  let secondJourneyId: string; // second journey, same tenant, used by bulk
  let gynJourneyId: string; // other-tenant journey
  let gynPatientId: string;
  let secondPatientId: string;
  let doctorTaskId: string;
  let coordinatorTaskId: string;
  let customFieldDefId: string;

  const COORD_NOTE = `PHI-adjacent-coordinator-note-${RUN}`;
  const DOCTOR_NOTE = `doctor-own-note-${RUN}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "eye.admin@pulseos.local");
    coordinatorCookie = await loginAs(app, "eye.coordinator@pulseos.local");
    doctorCookie = await loginAs(app, "eye.doctor@pulseos.local");
    frontdeskCookie = await loginAs(app, "eye.frontdesk@pulseos.local");
    gynAdminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    const gynDoctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");
    admin = await sessionUser(app, adminCookie);
    coordinator = await sessionUser(app, coordinatorCookie);
    doctor = await sessionUser(app, doctorCookie);
    frontdesk = await sessionUser(app, frontdeskCookie);
    gynAdmin = await sessionUser(app, gynAdminCookie);
    gynDoctor = await sessionUser(app, gynDoctorCookie);

    const lookups = (await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: adminCookie } })).json() as Lookups;
    branchId = lookups.branches[0].id;
    campaign = lookups.campaigns[0];

    // Fully populated fixture journey: owner = coordinator, campaign, two tasks
    // (coordinator + doctor), appointment with the doctor, treatment, revenue,
    // a custom field value.
    const lead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: adminCookie },
      payload: {
        name: `Detail Fixture ${RUN}`,
        phone: uniquePhone(),
        specialtyKey: "CATARACT",
        branchId,
        source: "meta",
        campaignId: campaign.id,
        journeyType: "Cataract Consultation",
        ownerId: coordinator.id,
      },
    });
    expect(lead.statusCode).toBe(201);
    const created = lead.json() as CreateLeadResult;
    patientId = created.patientId;
    journeyId = created.journeyId;

    const second = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: adminCookie },
      payload: { name: `Detail Fixture Two ${RUN}`, phone: uniquePhone(), specialtyKey: "CATARACT", branchId, source: "website", journeyType: "Cataract Consultation" },
    });
    secondJourneyId = (second.json() as CreateLeadResult).journeyId;
    secondPatientId = (second.json() as CreateLeadResult).patientId;

    const gynLead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: gynAdminCookie },
      payload: {
        name: `Gyn Fixture ${RUN}`,
        phone: uniquePhone(),
        specialtyKey: "GYNECOLOGY",
        branchId: ((await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: gynAdminCookie } })).json() as Lookups).branches[0].id,
        source: "website",
        journeyType: "Gynecology Consultation",
      },
    });
    expect(gynLead.statusCode).toBe(201);
    gynJourneyId = (gynLead.json() as CreateLeadResult).journeyId;
    gynPatientId = (gynLead.json() as CreateLeadResult).patientId;

    const dueAt = new Date(Date.now() + 2 * 86400000).toISOString();
    const t1 = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: adminCookie },
      payload: { patientId, journeyId, type: "CALLBACK", dueAt, assignedTo: coordinator.id, notes: COORD_NOTE },
    });
    coordinatorTaskId = (t1.json() as TaskRow).id;
    const t2 = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: adminCookie },
      payload: { patientId, journeyId, type: "FOLLOW_UP", dueAt: new Date(Date.now() + 5 * 86400000).toISOString(), assignedTo: doctor.id, notes: DOCTOR_NOTE },
    });
    doctorTaskId = (t2.json() as TaskRow).id;

    const appt = await app.inject({
      method: "POST",
      url: "/appointments",
      cookies: { pulseos_session: adminCookie },
      payload: { patientId, journeyId, branchId, doctorId: doctor.id, scheduledAt: new Date(Date.now() + 86400000).toISOString(), reason: "Cataract screening" },
    });
    expect(appt.statusCode).toBe(201);

    // Raw SQL with an explicit column list (rather than the Drizzle insert) so
    // this fixture doesn't depend on whichever optional treatment_opportunities
    // columns other in-flight schema work has or hasn't migrated yet.
    const inserted = await db.execute<{ id: string }>(
      sql`insert into treatment_opportunities (tenant_id, patient_id, journey_id, treatment_label, estimated_value, status)
          values (${admin.tenantId}, ${patientId}, ${journeyId}, ${`Phaco ${RUN}`}, 45000, 'ACCEPTED') returning id`,
    );
    const treatment = { id: inserted[0].id };
    await db.insert(revenueEvents).values({ tenantId: admin.tenantId, patientId, journeyId, treatmentOpportunityId: treatment.id, amount: 12000, type: "treatment_payment" });
    await db.insert(revenueEvents).values({ tenantId: admin.tenantId, patientId, journeyId, amount: 500, type: "consultation_fee" });

    const [def] = await db
      .insert(customFieldDefinitions)
      .values({ tenantId: admin.tenantId, specialtyKey: "CATARACT", key: `detail_test_${RUN}`, label: `Detail Test Field ${RUN}`, fieldType: "TEXT", required: false })
      .returning();
    customFieldDefId = def.id;
    await db.insert(customFieldValues).values({ tenantId: admin.tenantId, journeyId, fieldDefinitionId: def.id, value: "Right eye" });
  });

  afterAll(async () => {
    const ids = [journeyId, secondJourneyId, gynJourneyId].filter(Boolean);
    const patientIds = [patientId, gynPatientId, secondPatientId].filter(Boolean);
    if (ids.length) {
      await db.delete(revenueEvents).where(inArray(revenueEvents.journeyId, ids));
      await db.delete(treatmentOpportunities).where(inArray(treatmentOpportunities.journeyId, ids));
      await db.delete(customFieldValues).where(inArray(customFieldValues.journeyId, ids));
      await db.delete(tasks).where(inArray(tasks.journeyId, ids));
      await db.delete(appointments).where(inArray(appointments.journeyId, ids));
      await db.delete(timelineEvents).where(inArray(timelineEvents.journeyId, ids));
      await db.delete(campaignTouchpoints).where(inArray(campaignTouchpoints.journeyId, ids));
      await db.delete(journeys).where(inArray(journeys.id, ids));
    }
    if (customFieldDefId) await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, customFieldDefId));
    if (patientIds.length) {
      await db.delete(timelineEvents).where(inArray(timelineEvents.patientId, patientIds));
      await db.delete(patients).where(inArray(patients.id, patientIds));
    }
    await app.close();
    await queryClient.end();
  });

  const get = (id: string, cookie: string) => app.inject({ method: "GET", url: `/journeys/${id}`, cookies: { pulseos_session: cookie } });
  const patchOwner = (id: string, cookie: string, ownerUserId: string | null) =>
    app.inject({ method: "PATCH", url: `/journeys/${id}/owner`, cookies: { pulseos_session: cookie }, payload: { ownerUserId } });

  describe("GET /journeys/:id", () => {
    it("rejects unauthenticated with 401", async () => {
      const res = await app.inject({ method: "GET", url: `/journeys/${journeyId}` });
      expect(res.statusCode).toBe(401);
    });

    it("returns a fully populated detail for a manager (all sections)", async () => {
      const res = await get(journeyId, adminCookie);
      expect(res.statusCode).toBe(200);
      const d = res.json() as JourneyDetailVm;

      expect(d.patient).toMatchObject({ id: patientId, name: `Detail Fixture ${RUN}` });
      expect(d.patient.phone).toBeTruthy();
      expect(d.patient.branchName).toBeTruthy();

      expect(d.journey.id).toBe(journeyId);
      expect(d.journey.journeyType).toBe("Cataract Consultation");
      expect(d.journey.stage).toBe("enquiry");
      expect(d.journey.source).toBe("meta");
      expect(d.journey.campaign).toEqual({ id: campaign.id, name: campaign.name });
      expect(d.journey.owner).toEqual({ id: coordinator.id, name: coordinator.name });
      expect(d.journey.doctorName).toBe(doctor.name);
      expect(d.journey.createdAt).toBeTruthy();
      expect(d.journey.lastInteractionAt).toBeTruthy();
      expect(d.journey.nextAction).not.toBeNull();
      expect(d.journey.nextAction!.label.toLowerCase()).toContain("callback");
      expect(new Date(d.journey.nextAction!.dueAt).getTime()).toBeGreaterThan(Date.now());

      expect(d.customFields.find((f) => f.label === `Detail Test Field ${RUN}`)?.value).toBe("Right eye");

      expect(d.timeline.length).toBeGreaterThan(0);
      expect(d.timeline.map((e) => e.eventType)).toContain("lead_created");
      expect(d.tasks.map((t) => t.id).sort()).toEqual([coordinatorTaskId, doctorTaskId].sort());
      expect(d.appointments).toHaveLength(1);
      expect(d.appointments[0]).toMatchObject({ journeyId, doctorName: doctor.name });
      expect(d.treatments).toHaveLength(1);
      expect(d.treatments![0]).toMatchObject({ treatmentLabel: `Phaco ${RUN}`, estimatedValue: 45000 });
      expect(d.revenue!.total).toBe(12500);
      expect(d.revenue!.events).toHaveLength(2);
    });

    it("timeline is scoped to this journey only, not the patient's other journeys", async () => {
      // Second journey for the SAME patient (Patient != Journey).
      const other = await app.inject({
        method: "POST",
        url: "/leads",
        cookies: { pulseos_session: adminCookie },
        payload: { name: `Detail Fixture ${RUN}`, phone: (await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, patientId)))[0].phone, specialtyKey: "CATARACT", branchId, source: "phone", journeyType: "Second Journey Same Patient" },
      });
      const otherResult = other.json() as CreateLeadResult;
      expect(otherResult.patientId).toBe(patientId);
      try {
        const d = (await get(journeyId, adminCookie)).json() as JourneyDetailVm;
        const o = (await get(otherResult.journeyId, adminCookie)).json() as JourneyDetailVm;
        expect(d.timeline.every((e) => e.title !== "Lead created — Second Journey Same Patient")).toBe(true);
        expect(o.timeline.some((e) => e.title === "Lead created — Second Journey Same Patient")).toBe(true);
        expect(o.tasks).toHaveLength(0);
        expect(o.appointments).toHaveLength(0);
      } finally {
        await db.delete(timelineEvents).where(eq(timelineEvents.journeyId, otherResult.journeyId));
        await db.delete(journeys).where(eq(journeys.id, otherResult.journeyId));
      }
    });

    it("another tenant's journey id is indistinguishable from not-found (404)", async () => {
      const cross = await get(journeyId, gynAdminCookie);
      const missing = await get("00000000-0000-0000-0000-000000000000", gynAdminCookie);
      expect(cross.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(cross.json()).toEqual(missing.json());
      const reverse = await get(gynJourneyId, adminCookie);
      expect(reverse.statusCode).toBe(404);
    });

    it("non-existent and malformed ids are 404", async () => {
      expect((await get("00000000-0000-0000-0000-000000000000", adminCookie)).statusCode).toBe(404);
      expect((await get("not-a-uuid", adminCookie)).statusCode).toBe(404);
    });

    it("a Doctor (no MANAGE_TASKS) sees only tasks assigned to themselves — never another staff member's task notes", async () => {
      const res = await get(journeyId, doctorCookie);
      expect(res.statusCode).toBe(200);
      const d = res.json() as JourneyDetailVm;
      expect(d.tasks.map((t) => t.id)).toEqual([doctorTaskId]);
      expect(d.tasks[0].notes).toBe(DOCTOR_NOTE);
      expect(JSON.stringify(d)).not.toContain(COORD_NOTE);
    });

    it("a manager sees every task on the journey including others' notes", async () => {
      const d = (await get(journeyId, coordinatorCookie)).json() as JourneyDetailVm;
      expect(d.tasks.map((t) => t.notes)).toEqual(expect.arrayContaining([COORD_NOTE, DOCTOR_NOTE]));
    });

    it("revenue is withheld (null) from roles without VIEW_REVENUE, and treatments from roles without VIEW_TREATMENT", async () => {
      const doc = (await get(journeyId, doctorCookie)).json() as JourneyDetailVm;
      expect(doc.revenue).toBeNull(); // Doctor: VIEW_TREATMENT but not VIEW_REVENUE
      expect(doc.treatments).toHaveLength(1);
      const fd = (await get(journeyId, frontdeskCookie)).json() as JourneyDetailVm;
      expect(fd.revenue).toBeNull();
      expect(fd.treatments).toBeNull(); // Front Desk: neither
    });
  });

  describe("PATCH /journeys/:id/owner", () => {
    async function ownerEventCount(): Promise<number> {
      const rows = await db
        .select({ id: timelineEvents.id })
        .from(timelineEvents)
        .where(and(eq(timelineEvents.journeyId, journeyId), eq(timelineEvents.eventType, "journey_owner_changed")));
      return rows.length;
    }
    async function taskSnapshot() {
      const rows = await db.select({ id: tasks.id, assignedTo: tasks.assignedTo, notes: tasks.notes, status: tasks.status, dueAt: tasks.dueAt }).from(tasks).where(eq(tasks.journeyId, journeyId));
      return rows.sort((a, b) => a.id.localeCompare(b.id));
    }

    it("admin reassigns: persists owner, writes exactly one timeline event by the actor, leaves tasks untouched, returns updated detail", async () => {
      const beforeEvents = await ownerEventCount();
      const beforeTasks = await taskSnapshot();

      const res = await patchOwner(journeyId, adminCookie, frontdesk.id);
      expect(res.statusCode).toBe(200);
      const d = res.json() as JourneyDetailVm;
      expect(d.journey.owner).toEqual({ id: frontdesk.id, name: frontdesk.name });

      expect((await get(journeyId, adminCookie).then((r) => r.json())).journey.owner.id).toBe(frontdesk.id);
      expect(await ownerEventCount()).toBe(beforeEvents + 1);

      const [evt] = await db
        .select()
        .from(timelineEvents)
        .where(and(eq(timelineEvents.journeyId, journeyId), eq(timelineEvents.eventType, "journey_owner_changed")));
      expect(evt.actorType).toBe("user");
      expect(evt.actorId).toBe(admin.id);
      expect(evt.patientId).toBe(patientId);
      expect(evt.title).toContain(frontdesk.name);

      expect(await taskSnapshot()).toEqual(beforeTasks);
    });

    it("re-assigning to the same owner is a no-op (no second timeline event)", async () => {
      const before = await ownerEventCount();
      const res = await patchOwner(journeyId, adminCookie, frontdesk.id);
      expect(res.statusCode).toBe(200);
      expect(await ownerEventCount()).toBe(before);
    });

    it("a coordinator (MANAGE_JOURNEYS) can reassign", async () => {
      const res = await patchOwner(journeyId, coordinatorCookie, coordinator.id);
      expect(res.statusCode).toBe(200);
      expect((res.json() as JourneyDetailVm).journey.owner?.id).toBe(coordinator.id);
    });

    it("null unassigns the journey", async () => {
      const before = await ownerEventCount();
      const res = await patchOwner(journeyId, adminCookie, null);
      expect(res.statusCode).toBe(200);
      expect((res.json() as JourneyDetailVm).journey.owner).toBeNull();
      expect(await ownerEventCount()).toBe(before + 1);
      const [row] = await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId));
      expect(row.owner).toBeNull();
      // Restore for later tests.
      await patchOwner(journeyId, adminCookie, coordinator.id);
    });

    it("Front Desk and Doctor are forbidden (403, MANAGE_JOURNEYS) and nothing changes", async () => {
      const before = (await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId)))[0].owner;
      const fd = await patchOwner(journeyId, frontdeskCookie, frontdesk.id);
      expect(fd.statusCode).toBe(403);
      expect(fd.json().requiredPermission).toBe("MANAGE_JOURNEYS");
      const doc = await patchOwner(journeyId, doctorCookie, doctor.id);
      expect(doc.statusCode).toBe(403);
      const after = (await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId)))[0].owner;
      expect(after).toBe(before);
    });

    it("unauthenticated is 401", async () => {
      const res = await app.inject({ method: "PATCH", url: `/journeys/${journeyId}/owner`, payload: { ownerUserId: null } });
      expect(res.statusCode).toBe(401);
    });

    it("an assignee from another tenant is rejected with 422 and the owner is unchanged", async () => {
      const before = (await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId)))[0].owner;
      const res = await patchOwner(journeyId, adminCookie, gynDoctor.id);
      expect(res.statusCode).toBe(422);
      const after = (await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId)))[0].owner;
      expect(after).toBe(before);
    });

    it("a non-existent assignee is rejected with 422", async () => {
      const res = await patchOwner(journeyId, adminCookie, "00000000-0000-0000-0000-000000000000");
      expect(res.statusCode).toBe(422);
    });

    it("another tenant's journey is 404 for the caller, and is not modified", async () => {
      const res = await patchOwner(journeyId, gynAdminCookie, gynAdmin.id);
      expect(res.statusCode).toBe(404);
      const [row] = await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, journeyId));
      expect(row.owner).not.toBe(gynAdmin.id);
    });

    it("non-existent journey is 404", async () => {
      const res = await patchOwner("00000000-0000-0000-0000-000000000000", adminCookie, coordinator.id);
      expect(res.statusCode).toBe(404);
    });

    it("rejects a malformed body with 400", async () => {
      const res = await app.inject({ method: "PATCH", url: `/journeys/${journeyId}/owner`, cookies: { pulseos_session: adminCookie }, payload: { ownerUserId: "nope" } });
      expect(res.statusCode).toBe(400);
      const missing = await app.inject({ method: "PATCH", url: `/journeys/${journeyId}/owner`, cookies: { pulseos_session: adminCookie }, payload: {} });
      expect(missing.statusCode).toBe(400);
    });
  });

  describe("POST /journeys/owner (bulk)", () => {
    const bulk = (cookie: string, journeyIds: string[], ownerUserId: string | null) =>
      app.inject({ method: "POST", url: "/journeys/owner", cookies: { pulseos_session: cookie }, payload: { journeyIds, ownerUserId } });
    const ownerOf = async (id: string) => (await db.select({ owner: journeys.ownerUserId }).from(journeys).where(eq(journeys.id, id)))[0].owner;

    it("assigns several journeys atomically and writes one timeline event each", async () => {
      const res = await bulk(adminCookie, [journeyId, secondJourneyId], frontdesk.id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ updatedCount: 2, owner: { id: frontdesk.id, name: frontdesk.name } });
      expect(await ownerOf(journeyId)).toBe(frontdesk.id);
      expect(await ownerOf(secondJourneyId)).toBe(frontdesk.id);
      const events = await db
        .select({ id: timelineEvents.id })
        .from(timelineEvents)
        .where(and(inArray(timelineEvents.journeyId, [journeyId, secondJourneyId]), eq(timelineEvents.eventType, "journey_owner_changed"), eq(timelineEvents.actorId, admin.id)));
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it("is all-or-nothing: one out-of-tenant id rejects with 404 and nothing is updated", async () => {
      await bulk(adminCookie, [journeyId, secondJourneyId], coordinator.id);
      const res = await bulk(adminCookie, [journeyId, secondJourneyId, gynJourneyId], frontdesk.id);
      expect(res.statusCode).toBe(404);
      expect(await ownerOf(journeyId)).toBe(coordinator.id);
      expect(await ownerOf(secondJourneyId)).toBe(coordinator.id);
      expect(await ownerOf(gynJourneyId)).not.toBe(frontdesk.id);
    });

    it("cross-tenant assignee is 422 and nothing is updated", async () => {
      const res = await bulk(adminCookie, [journeyId, secondJourneyId], gynDoctor.id);
      expect(res.statusCode).toBe(422);
      expect(await ownerOf(journeyId)).toBe(coordinator.id);
    });

    it("null unassigns all", async () => {
      const res = await bulk(adminCookie, [journeyId, secondJourneyId], null);
      expect(res.statusCode).toBe(200);
      expect(res.json().owner).toBeNull();
      expect(await ownerOf(journeyId)).toBeNull();
      expect(await ownerOf(secondJourneyId)).toBeNull();
      await bulk(adminCookie, [journeyId], coordinator.id);
    });

    it("does not touch tasks", async () => {
      const before = await db.select({ id: tasks.id, assignedTo: tasks.assignedTo }).from(tasks).where(eq(tasks.journeyId, journeyId));
      await bulk(adminCookie, [journeyId, secondJourneyId], frontdesk.id);
      const after = await db.select({ id: tasks.id, assignedTo: tasks.assignedTo }).from(tasks).where(eq(tasks.journeyId, journeyId));
      expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual(before.sort((a, b) => a.id.localeCompare(b.id)));
      await bulk(adminCookie, [journeyId], coordinator.id);
    });

    it("is forbidden without MANAGE_JOURNEYS (403)", async () => {
      expect((await bulk(frontdeskCookie, [journeyId], frontdesk.id)).statusCode).toBe(403);
      expect((await bulk(doctorCookie, [journeyId], doctor.id)).statusCode).toBe(403);
    });

    it("validates the body: 1..100 unique-shaped uuids", async () => {
      expect((await bulk(adminCookie, [], null)).statusCode).toBe(400);
      expect((await bulk(adminCookie, ["nope"], null)).statusCode).toBe(400);
      const many = Array.from({ length: 101 }, () => journeyId);
      expect((await bulk(adminCookie, many, null)).statusCode).toBe(400);
    });

    it("de-duplicates repeated ids", async () => {
      const res = await bulk(adminCookie, [journeyId, journeyId], coordinator.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().updatedCount).toBe(1);
    });
  });

  describe("owner filters (server-side)", () => {
    const listLeads = async (cookie: string, owner?: string) => {
      const res = await app.inject({ method: "GET", url: `/leads${owner ? `?owner=${owner}` : ""}`, cookies: { pulseos_session: cookie } });
      expect(res.statusCode).toBe(200);
      return res.json() as LeadRow[];
    };
    const listJourneys = async (cookie: string, owner: string) => {
      const res = await app.inject({ method: "GET", url: `/journeys?owner=${owner}`, cookies: { pulseos_session: cookie } });
      expect(res.statusCode).toBe(200);
      return res.json() as { id: string }[];
    };

    beforeAll(async () => {
      await patchOwner(journeyId, adminCookie, frontdesk.id);
      await patchOwner(secondJourneyId, adminCookie, null);
    });

    it("LeadRow exposes ownerId", async () => {
      const rows = await listLeads(adminCookie);
      const row = rows.find((r) => r.id === journeyId)!;
      expect(row.ownerId).toBe(frontdesk.id);
      expect(row.ownerName).toBe(frontdesk.name);
      expect(rows.find((r) => r.id === secondJourneyId)!.ownerId).toBeNull();
    });

    it("owner=mine resolves from the session: Front Desk gets only their own", async () => {
      const rows = await listLeads(frontdeskCookie, "mine");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ownerId === frontdesk.id)).toBe(true);
      expect(rows.map((r) => r.id)).toContain(journeyId);
      expect(rows.map((r) => r.id)).not.toContain(secondJourneyId);

      const coordRows = await listLeads(coordinatorCookie, "mine");
      expect(coordRows.every((r) => r.ownerId === coordinator.id)).toBe(true);
      expect(coordRows.map((r) => r.id)).not.toContain(journeyId);
    });

    it("owner=unassigned returns only unowned journeys", async () => {
      const rows = await listLeads(adminCookie, "unassigned");
      expect(rows.every((r) => r.ownerId === null)).toBe(true);
      expect(rows.map((r) => r.id)).toContain(secondJourneyId);
      expect(rows.map((r) => r.id)).not.toContain(journeyId);
    });

    it("owner=<userId> returns only that user's journeys", async () => {
      const rows = await listLeads(adminCookie, frontdesk.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.ownerId === frontdesk.id)).toBe(true);
      expect(rows.map((r) => r.id)).toContain(journeyId);
    });

    it("owner=<userId of another tenant> returns nothing (never leaks across tenants)", async () => {
      const rows = await listLeads(adminCookie, gynDoctor.id);
      expect(rows).toHaveLength(0);
    });

    it("a malformed owner value is 400", async () => {
      const res = await app.inject({ method: "GET", url: "/leads?owner=bogus", cookies: { pulseos_session: adminCookie } });
      expect(res.statusCode).toBe(400);
    });

    it("the same owner param works on GET /journeys (mine / unassigned / userId), and ownerId is still honoured", async () => {
      const mine = await listJourneys(frontdeskCookie, "mine");
      expect(mine.map((r) => r.id)).toContain(journeyId);
      expect(mine.map((r) => r.id)).not.toContain(secondJourneyId);

      const unassigned = await listJourneys(adminCookie, "unassigned");
      expect(unassigned.map((r) => r.id)).toContain(secondJourneyId);
      expect(unassigned.map((r) => r.id)).not.toContain(journeyId);

      const byId = await listJourneys(adminCookie, frontdesk.id);
      expect(byId.map((r) => r.id)).toContain(journeyId);

      const legacy = await app.inject({ method: "GET", url: `/journeys?ownerId=${frontdesk.id}`, cookies: { pulseos_session: adminCookie } });
      expect((legacy.json() as { id: string }[]).map((r) => r.id)).toContain(journeyId);
    });
  });
});

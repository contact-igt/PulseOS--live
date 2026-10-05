import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { dayKeyIn } from "../lib/hospital-time.js";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { patients, tasks, tenants, timelineEvents } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { JourneyListRow, SessionUser, TaskRow } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("tasks / follow-ups / my work (integration)", () => {
  let app: FastifyInstance;
  let coordinatorCookie: string;
  let doctorCookie: string;
  let doctor2Cookie: string;
  let somePatientId: string;
  let someJourneyId: string;
  let doctorId: string;
  let doctor2Id: string;
  let coordinatorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");
    doctor2Cookie = await loginAs(app, "gyn.doctor2@pulseos.local");

    const journeys = await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: coordinatorCookie } });
    const rows = journeys.json() as JourneyListRow[];
    somePatientId = rows[0].patientId;
    someJourneyId = rows[0].id;

    const doctorSession = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: doctorCookie } });
    doctorId = (doctorSession.json() as { user: SessionUser }).user.id;
    const doctor2Session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: doctor2Cookie } });
    doctor2Id = (doctor2Session.json() as { user: SessionUser }).user.id;
    const coordinatorSession = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } });
    coordinatorId = (coordinatorSession.json() as { user: SessionUser }).user.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401, not 403", async () => {
    const res = await app.inject({ method: "GET", url: "/tasks" });
    expect(res.statusCode).toBe(401);
  });

  it("Doctor has VIEW_TASKS (can see their own My Work queue) but not MANAGE_TASKS (cannot create, complete, reschedule, or reassign)", async () => {
    const list = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: doctorCookie } });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json())).toBe(true);

    const create = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: doctorCookie },
      payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().requiredPermission).toBe("MANAGE_TASKS");

    const complete = await app.inject({ method: "PATCH", url: "/tasks/00000000-0000-0000-0000-000000000000/complete", cookies: { pulseos_session: doctorCookie } });
    expect(complete.statusCode).toBe(403);
    expect(complete.json().requiredPermission).toBe("MANAGE_TASKS");
  });

  it("aggregates task counts per view for the current session's own tasks in one efficient query, respecting tenant + assignment", async () => {
    const session = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } });
    const { user } = session.json() as { user: SessionUser };

    const before = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: coordinatorCookie } });
    expect(before.statusCode).toBe(200);
    const beforeCounts = before.json() as { mine: number; overdue: number; today: number; upcoming: number; completed: number };

    const overdueDue = new Date(Date.now() - 2 * 86400000).toISOString();
    // Halfway between now and the HOSPITAL's midnight (the tenant's timezone, not the test process's): always
    // later today and still in the future, whatever the time of day or TZ the suite runs under.
    const endOfToday = new Date(Date.parse(`${dayKeyIn(new Date(), "Asia/Kolkata")}T00:00:00+05:30`) + 86_400_000);
    const todayDue = new Date(Date.now() + (endOfToday.getTime() - Date.now()) / 2).toISOString();
    const upcomingDue = new Date(Date.now() + 5 * 86400000).toISOString();

    await app.inject({ method: "POST", url: "/tasks", cookies: { pulseos_session: coordinatorCookie }, payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: overdueDue, assignedTo: user.id } });
    await app.inject({ method: "POST", url: "/tasks", cookies: { pulseos_session: coordinatorCookie }, payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: todayDue, assignedTo: user.id } });
    await app.inject({ method: "POST", url: "/tasks", cookies: { pulseos_session: coordinatorCookie }, payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: upcomingDue, assignedTo: user.id } });
    const toComplete = await app.inject({ method: "POST", url: "/tasks", cookies: { pulseos_session: coordinatorCookie }, payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: upcomingDue, assignedTo: user.id } });
    await app.inject({ method: "PATCH", url: `/tasks/${(toComplete.json() as TaskRow).id}/complete`, cookies: { pulseos_session: coordinatorCookie } });

    const after = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: coordinatorCookie } });
    expect(after.statusCode).toBe(200);
    const afterCounts = after.json() as typeof beforeCounts;

    expect(afterCounts.mine).toBe(beforeCounts.mine + 4);
    expect(afterCounts.overdue).toBe(beforeCounts.overdue + 1);
    expect(afterCounts.today).toBe(beforeCounts.today + 1);
    expect(afterCounts.upcoming).toBe(beforeCounts.upcoming + 1);
    expect(afterCounts.completed).toBe(beforeCounts.completed + 1);
  });

  it("task counts are scoped to the caller's own assignment — a doctor's counts never include a coordinator's tasks", async () => {
    const coordinatorSession = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } });
    const { user: coordinatorUser } = coordinatorSession.json() as { user: SessionUser };

    const before = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: doctorCookie } });
    const beforeCounts = before.json() as { mine: number };

    // Explicitly assigned to the coordinator, not the doctor — must not move the doctor's count.
    await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000).toISOString(), assignedTo: coordinatorUser.id },
    });

    const after = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: doctorCookie } });
    const afterCounts = after.json() as { mine: number };
    expect(afterCounts.mine).toBe(beforeCounts.mine);
  });

  it("GET /tasks rows carry the owning Journey's acquisition source (read-model field for My Work), null when the task has no Journey", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000).toISOString() },
    });
    const { id } = created.json() as TaskRow;

    const journeysRes = await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: coordinatorCookie } });
    const journey = (journeysRes.json() as JourneyListRow[]).find((j) => j.id === someJourneyId)!;

    const list = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: coordinatorCookie } });
    const row = (list.json() as TaskRow[]).find((t) => t.id === id)!;
    expect(typeof row.source).toBe("string");
    expect(row.source).toBe(journey.source);

    // A scratch patient with no journey at all: attaching a journey-less task to
    // a real (single-journey) patient would leave a row the seed-integrity check
    // rightly flags, and other files run against the same DB in parallel.
    const tenantId = (await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: coordinatorCookie } })).json().user.tenantId as string;
    const [scratch] = await db.insert(patients).values({ tenantId, name: "Scratch No-Journey Patient", phone: "+910000000001" }).returning();
    try {
      const noJourney = await app.inject({
        method: "POST",
        url: "/tasks",
        cookies: { pulseos_session: coordinatorCookie },
        payload: { patientId: scratch.id, type: "OTHER", dueAt: new Date(Date.now() + 86400000).toISOString() },
      });
      const noJourneyId = (noJourney.json() as TaskRow).id;
      const list2 = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: coordinatorCookie } });
      expect((list2.json() as TaskRow[]).find((t) => t.id === noJourneyId)!.source).toBeNull();
    } finally {
      await db.delete(tasks).where(eq(tasks.patientId, scratch.id));
      await db.delete(timelineEvents).where(eq(timelineEvents.patientId, scratch.id));
      await db.delete(patients).where(eq(patients.id, scratch.id));
    }
  });

  it("creates a task with the full field set and returns it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: coordinatorCookie },
      payload: {
        patientId: somePatientId,
        journeyId: someJourneyId,
        type: "CALLBACK",
        priority: "high",
        notes: "Call back after 6pm",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json() as TaskRow;
    expect(task.type).toBe("CALLBACK");
    expect(task.priority).toBe("high");
    expect(task.notes).toBe("Call back after 6pm");
    expect(task.status).toBe("pending");
    expect(task.patientId).toBe(somePatientId);
  });

  it("lists tasks filtered by view (today/overdue/upcoming/completed)", async () => {
    for (const view of ["today", "overdue", "upcoming", "completed"]) {
      const res = await app.inject({ method: "GET", url: `/tasks?view=${view}`, cookies: { pulseos_session: coordinatorCookie } });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    }
  });

  it("full lifecycle: create → add note → reschedule → reassign → complete, each writing a Timeline event", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/tasks",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { patientId: somePatientId, journeyId: someJourneyId, type: "FOLLOW_UP", dueAt: new Date(Date.now() + 3600000).toISOString() },
    });
    const task = create.json() as TaskRow;

    const note = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}/note`,
      cookies: { pulseos_session: coordinatorCookie },
      payload: { notes: "Patient asked to call tomorrow morning" },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json().notes).toBe("Patient asked to call tomorrow morning");

    const newDue = new Date(Date.now() + 2 * 86400000).toISOString();
    const reschedule = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}/reschedule`,
      cookies: { pulseos_session: coordinatorCookie },
      payload: { dueAt: newDue },
    });
    expect(reschedule.statusCode).toBe(200);

    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: coordinatorCookie } });
    const owners = lookups.json().owners as { id: string }[];
    const otherOwner = owners.find((o: { id: string }) => o.id);
    const reassign = await app.inject({
      method: "PATCH",
      url: `/tasks/${task.id}/reassign`,
      cookies: { pulseos_session: coordinatorCookie },
      payload: { assignedTo: otherOwner!.id },
    });
    expect(reassign.statusCode).toBe(200);

    const complete = await app.inject({ method: "PATCH", url: `/tasks/${task.id}/complete`, cookies: { pulseos_session: coordinatorCookie } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().status).toBe("completed");

    const completeAgain = await app.inject({ method: "PATCH", url: `/tasks/${task.id}/complete`, cookies: { pulseos_session: coordinatorCookie } });
    expect(completeAgain.statusCode).toBe(409);

    const timeline = await app.inject({ method: "GET", url: `/patients/${somePatientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const events = timeline.json() as { eventType: string }[];
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain("task_created");
    expect(eventTypes).toContain("task_rescheduled");
    expect(eventTypes).toContain("task_reassigned");
    expect(eventTypes).toContain("task_completed");
  });

  it("tenant isolation: cannot complete a task belonging to another tenant", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/tasks/00000000-0000-0000-0000-000000000000/complete",
      cookies: { pulseos_session: coordinatorCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("every journey exposes a Next Action (due date) or explicitly none", async () => {
    const res = await app.inject({ method: "GET", url: "/journeys", cookies: { pulseos_session: coordinatorCookie } });
    const rows = res.json() as JourneyListRow[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.nextActionDueAt === null || typeof row.nextActionDueAt === "string").toBe(true);
      expect(typeof row.lastActivityAt).toBe("string");
    }
  });

  // Regression coverage for the audit finding: GET /tasks was gated only by
  // VIEW_TASKS with zero additional scoping, so a Doctor (VIEW_TASKS but not
  // MANAGE_TASKS) could read every other staff member's tasks — including
  // PHI-adjacent task notes — tenant-wide, and could pass an arbitrary
  // `assignedTo` query param straight through. The fix scopes any caller
  // without MANAGE_TASKS to their own assignments server-side, while callers
  // with MANAGE_TASKS (Coordinator/Front Desk/Admin) keep the existing
  // full-tenant view unchanged.
  describe("GET /tasks scoping — VIEW_TASKS-only vs MANAGE_TASKS (security fix)", () => {
    let doctor2OwnTaskId: string;

    beforeAll(async () => {
      // A task assigned to a *different* doctor, with a PHI-adjacent note — the
      // "another staff member's unrelated task" a VIEW_TASKS-only caller must
      // never be able to read, whether via the unscoped list or a spoofed
      // assignedTo param.
      const created = await app.inject({
        method: "POST",
        url: "/tasks",
        cookies: { pulseos_session: coordinatorCookie },
        payload: {
          patientId: somePatientId,
          journeyId: someJourneyId,
          type: "CALLBACK",
          notes: "Confidential: patient disclosed condition X to Dr. Nair",
          dueAt: new Date(Date.now() + 86400000).toISOString(),
          assignedTo: doctor2Id,
        },
      });
      doctor2OwnTaskId = (created.json() as TaskRow).id;

      // The first doctor also gets a task of their own, to prove self-visibility stays intact.
      await app.inject({
        method: "POST",
        url: "/tasks",
        cookies: { pulseos_session: coordinatorCookie },
        payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000).toISOString(), assignedTo: doctorId },
      });
    });

    it("(a) a VIEW_TASKS-only doctor sees their own assigned tasks", async () => {
      const res = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: doctorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.length).toBeGreaterThan(0);
      expect(rowsList.every((t) => t.assignedTo === doctorId)).toBe(true);
    });

    it("(b) a MANAGE_TASKS role (coordinator) still sees the full tenant task queue, unchanged", async () => {
      const res = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: coordinatorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.map((t) => t.id)).toContain(doctor2OwnTaskId);
      // proves the coordinator's view is not scoped down to only their own assignments
      expect(rowsList.some((t) => t.assignedTo !== coordinatorId)).toBe(true);
    });

    it("(c) a VIEW_TASKS-only doctor cannot see another staff member's task via the unscoped list", async () => {
      const res = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: doctorCookie } });
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.map((t) => t.id)).not.toContain(doctor2OwnTaskId);
    });

    it("(c) a VIEW_TASKS-only doctor cannot bypass scoping with a spoofed assignedTo query param, a direct API call the UI would never send", async () => {
      const res = await app.inject({ method: "GET", url: `/tasks?assignedTo=${doctor2Id}`, cookies: { pulseos_session: doctorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.map((t) => t.id)).not.toContain(doctor2OwnTaskId);
      // the server overrides the spoofed assignedTo back to the caller's own id
      expect(rowsList.every((t) => t.assignedTo === doctorId)).toBe(true);
    });

    it("(d) cross-tenant isolation holds: a task from another tenant is never returned to any caller in this tenant, even via a spoofed direct API bypass", async () => {
      const [otherTenant] = await db.insert(tenants).values({ name: "Cross-Tenant Isolation Test Hospital" }).returning();
      const [otherPatient] = await db.insert(patients).values({ tenantId: otherTenant.id, name: "Other Tenant Patient", phone: "+919876500099" }).returning();
      const [otherTask] = await db.insert(tasks).values({ tenantId: otherTenant.id, patientId: otherPatient.id, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000) }).returning();

      const coordinatorList = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: coordinatorCookie } });
      expect((coordinatorList.json() as TaskRow[]).map((t) => t.id)).not.toContain(otherTask.id);

      const doctorList = await app.inject({ method: "GET", url: "/tasks", cookies: { pulseos_session: doctorCookie } });
      expect((doctorList.json() as TaskRow[]).map((t) => t.id)).not.toContain(otherTask.id);

      // (e) direct bypass attempt: a raw crafted query the UI would never send, requesting
      // the other tenant's patient — must not leak it either, tenantId scoping always wins.
      const spoofed = await app.inject({ method: "GET", url: `/tasks?assignedTo=${doctorId}&patientId=${otherPatient.id}`, cookies: { pulseos_session: doctorCookie } });
      expect((spoofed.json() as TaskRow[]).map((t) => t.id)).not.toContain(otherTask.id);
    });
  });

  // Follow-on to the security fix above: system-generated tasks (missed-call
  // callbacks, post-care, recall, treatment-decision-pending, new-lead
  // contact) can be created with `assignedTo: null` when no journey owner
  // exists yet. Those must not become operationally invisible — they need an
  // intentional "team attention" surface, restricted to the same MANAGE_TASKS
  // roles that already have full tenant-wide task visibility (front desk,
  // coordinator, admin), never a tenant-wide queue for a VIEW_TASKS-only role.
  describe("GET /tasks?view=unassigned — team-attention queue for owner-less system tasks", () => {
    let unassignedTaskId: string;

    beforeAll(async () => {
      // Created without `assignedTo` — createTask defaults it to null, the
      // same shape call-webhook.service.ts / treatment.service.ts produce
      // when no journey owner exists yet.
      const created = await app.inject({
        method: "POST",
        url: "/tasks",
        cookies: { pulseos_session: coordinatorCookie },
        payload: {
          patientId: somePatientId,
          journeyId: someJourneyId,
          type: "CALLBACK",
          notes: "Unassigned regression fixture",
          dueAt: new Date(Date.now() + 86400000).toISOString(),
        },
      });
      expect(created.statusCode).toBe(200);
      const task = created.json() as TaskRow;
      expect(task.assignedTo).toBeNull();
      unassignedTaskId = task.id;
    });

    it("(a) a MANAGE_TASKS role (coordinator) sees the unassigned pending task in the unassigned view", async () => {
      const res = await app.inject({ method: "GET", url: "/tasks?view=unassigned", cookies: { pulseos_session: coordinatorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.map((t) => t.id)).toContain(unassignedTaskId);
      expect(rowsList.every((t) => t.assignedTo === null)).toBe(true);
      expect(rowsList.every((t) => t.status === "pending" || t.status === "in_progress")).toBe(true);
    });

    it("(b) a completed task never appears in the unassigned view, even if it was never assigned", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/tasks",
        cookies: { pulseos_session: coordinatorCookie },
        payload: { patientId: somePatientId, journeyId: someJourneyId, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000).toISOString() },
      });
      const task = create.json() as TaskRow;
      expect(task.assignedTo).toBeNull();

      const complete = await app.inject({ method: "PATCH", url: `/tasks/${task.id}/complete`, cookies: { pulseos_session: coordinatorCookie } });
      expect(complete.statusCode).toBe(200);

      const res = await app.inject({ method: "GET", url: "/tasks?view=unassigned", cookies: { pulseos_session: coordinatorCookie } });
      const rowsList = res.json() as TaskRow[];
      expect(rowsList.map((t) => t.id)).not.toContain(task.id);
    });

    it("(c) a VIEW_TASKS-only doctor requesting the unassigned view gets an empty/own-only result, never the tenant-wide unassigned queue (no bypass)", async () => {
      const res = await app.inject({ method: "GET", url: "/tasks?view=unassigned", cookies: { pulseos_session: doctorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      // The doctor's server-forced assignedTo (their own id) can never equal
      // NULL, so this must always be empty — proving the override composes
      // safely with the new view's `assignedTo IS NULL` condition.
      expect(rowsList).toEqual([]);
      expect(rowsList.map((t) => t.id)).not.toContain(unassignedTaskId);
    });

    it("(d) a VIEW_TASKS-only doctor cannot bypass the unassigned gate with a spoofed assignedTo query param either", async () => {
      const res = await app.inject({ method: "GET", url: `/tasks?view=unassigned&assignedTo=${coordinatorId}`, cookies: { pulseos_session: doctorCookie } });
      expect(res.statusCode).toBe(200);
      const rowsList = res.json() as TaskRow[];
      expect(rowsList).toEqual([]);
    });

    it("(e) tenant isolation holds for the unassigned view: an unassigned task from another tenant is never returned", async () => {
      const [otherTenant] = await db.insert(tenants).values({ name: "Cross-Tenant Unassigned Test Hospital" }).returning();
      const [otherPatient] = await db.insert(patients).values({ tenantId: otherTenant.id, name: "Other Tenant Patient (Unassigned)", phone: "+919876500098" }).returning();
      const [otherTask] = await db.insert(tasks).values({ tenantId: otherTenant.id, patientId: otherPatient.id, type: "CALLBACK", dueAt: new Date(Date.now() + 86400000) }).returning();
      expect(otherTask.assignedTo).toBeNull();

      const coordinatorList = await app.inject({ method: "GET", url: "/tasks?view=unassigned", cookies: { pulseos_session: coordinatorCookie } });
      expect((coordinatorList.json() as TaskRow[]).map((t) => t.id)).not.toContain(otherTask.id);
    });

    it("(f) task counts expose a tenant-wide `unassigned` number for a MANAGE_TASKS role but omit it for a VIEW_TASKS-only doctor", async () => {
      const coordinatorCounts = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: coordinatorCookie } });
      expect(coordinatorCounts.statusCode).toBe(200);
      const cCounts = coordinatorCounts.json() as { unassigned?: number };
      expect(typeof cCounts.unassigned).toBe("number");
      expect(cCounts.unassigned).toBeGreaterThan(0);

      const doctorCounts = await app.inject({ method: "GET", url: "/tasks/counts", cookies: { pulseos_session: doctorCookie } });
      expect(doctorCounts.statusCode).toBe(200);
      const dCounts = doctorCounts.json() as { unassigned?: number };
      expect(dCounts.unassigned).toBeUndefined();
    });
  });
});

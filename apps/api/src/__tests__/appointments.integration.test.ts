import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, CreateLeadResult, Lookups } from "@pulseos/types";

// The same doctor cannot hold two visits in one minute, and these suites run against the shared seeded tenant (rows
// from earlier runs stay), so every future slot is a distinct, randomly placed minute within the next ~weeks.
let slotSeq = 0;
const futureSlot = (minDays = 1) => new Date(Date.now() + minDays * 86_400_000 + (Math.floor(Math.random() * 20_000) + ++slotSeq) * 60_000).toISOString();

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("appointments / front desk (integration)", () => {
  let app: FastifyInstance;
  let frontDeskCookie: string;
  let doctorCookie: string;
  let anyAppointmentId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");

    const res = await app.inject({ method: "GET", url: "/appointments", cookies: { pulseos_session: frontDeskCookie } });
    const rows = res.json() as AppointmentRow[];
    anyAppointmentId = rows[0].id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  // A row plucked from the seeded /appointments list could be in ANY open
  // status (seed.ts assigns them close to randomly) — fine when no
  // transition-order validation exists, but not once the server actually
  // enforces the canonical graph (see appointment-transitions.integration.test.ts):
  // a test assuming "this is freshly scheduled" could silently get a
  // "confirmed" or "checked_in" row instead and fail the FIRST transition it
  // attempts. Tests that need a specific starting status create their own
  // appointment (guaranteed "scheduled") rather than gambling on seed state.
  async function freshScheduledAppointment(): Promise<AppointmentRow> {
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: frontDeskCookie } });
    const { branches, doctors } = lookups.json() as Lookups;

    const lead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: frontDeskCookie },
      payload: {
        name: "Appointment Lifecycle Test Patient",
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
        specialtyKey: "GENERAL_OPD",
        branchId: branches[0].id,
        source: "walk_in",
        journeyType: "General Consultation",
      },
    });
    const { patientId, journeyId } = lead.json() as CreateLeadResult;

    const create = await app.inject({
      method: "POST",
      url: "/appointments",
      cookies: { pulseos_session: frontDeskCookie },
      payload: { patientId, journeyId, branchId: branches[0].id, doctorId: doctors[0].id, scheduledAt: futureSlot() },
    });
    return create.json() as AppointmentRow;
  }

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/appointments" });
    expect(res.statusCode).toBe(401);
  });

  it("front desk can view appointments and the front-desk dashboard", async () => {
    const [list, dashboard] = await Promise.all([
      app.inject({ method: "GET", url: "/appointments", cookies: { pulseos_session: frontDeskCookie } }),
      app.inject({ method: "GET", url: "/front-desk", cookies: { pulseos_session: frontDeskCookie } }),
    ]);
    expect(list.statusCode).toBe(200);
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json();
    for (const key of ["today", "arrivals", "waitingQueue", "noShows", "pendingConfirmations"]) {
      expect(Array.isArray(body[key])).toBe(true);
    }
  });

  it("doctor cannot manage (transition) an appointment — VIEW_APPOINTMENTS does not imply MANAGE_APPOINTMENTS", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/appointments/${anyAppointmentId}/action`,
      cookies: { pulseos_session: doctorCookie },
      payload: { action: "confirm" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("MANAGE_APPOINTMENTS");
  });

  it("full front-desk transition lifecycle writes Timeline events at each step, ending in a real WAITING state", async () => {
    const scheduled = await freshScheduledAppointment();

    const confirm = await app.inject({
      method: "PATCH", url: `/appointments/${scheduled.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "confirm" },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe("confirmed");

    const checkIn = await app.inject({
      method: "PATCH", url: `/appointments/${scheduled.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "check_in" },
    });
    expect(checkIn.json().status).toBe("checked_in");

    const waiting = await app.inject({
      method: "PATCH", url: `/appointments/${scheduled.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "mark_waiting" },
    });
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json().status).toBe("waiting");

    const sendToDoctor = await app.inject({
      method: "PATCH", url: `/appointments/${scheduled.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "send_to_doctor" },
    });
    expect(sendToDoctor.json().status).toBe("with_doctor");

    const complete = await app.inject({
      method: "PATCH", url: `/appointments/${scheduled.id}/complete`, cookies: { pulseos_session: frontDeskCookie },
    });
    expect(complete.statusCode).toBe(200);

    const timeline = await app.inject({ method: "GET", url: `/patients/${scheduled.patientId}/timeline`, cookies: { pulseos_session: frontDeskCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("appointment_confirmed");
    expect(eventTypes).toContain("appointment_checked_in");
    expect(eventTypes).toContain("appointment_waiting");
    expect(eventTypes).toContain("appointment_with_doctor");
    expect(eventTypes).toContain("appointment_completed");
  });

  it("Front Desk waiting queue rows carry arrivedAt (the real check-in time from the Timeline) so the UI can show an honest wait duration", async () => {
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: frontDeskCookie } });
    const { branches, doctors } = lookups.json() as Lookups;
    const lead = await app.inject({
      method: "POST", url: "/leads", cookies: { pulseos_session: frontDeskCookie },
      payload: { name: "Wait Duration Test Patient", phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "GENERAL_OPD", branchId: branches[0].id, source: "walk_in", journeyType: "General Consultation" },
    });
    const { patientId, journeyId } = lead.json() as CreateLeadResult;
    // Scheduled "now" so it lands in today's Front Desk board regardless of time of day.
    const create = await app.inject({
      method: "POST", url: "/appointments", cookies: { pulseos_session: frontDeskCookie },
      payload: { patientId, journeyId, branchId: branches[0].id, doctorId: doctors[0].id, scheduledAt: new Date().toISOString() },
    });
    const appt = create.json() as AppointmentRow;
    for (const action of ["confirm", "check_in", "mark_waiting"]) {
      const r = await app.inject({ method: "PATCH", url: `/appointments/${appt.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action } });
      expect(r.statusCode).toBe(200);
    }

    const fd = await app.inject({ method: "GET", url: "/front-desk", cookies: { pulseos_session: frontDeskCookie } });
    const queueRow = (fd.json() as { waitingQueue: AppointmentRow[] }).waitingQueue.find((r) => r.id === appt.id)!;
    expect(queueRow).toBeTruthy();
    expect(queueRow.arrivedAt).toBeTruthy();
    const ageMs = Date.now() - new Date(queueRow.arrivedAt!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(60_000);

    // Rows that are not in the waiting queue carry no arrival time.
    const scheduled = await freshScheduledAppointment();
    const list = await app.inject({ method: "GET", url: `/appointments?journeyId=${scheduled.journeyId}`, cookies: { pulseos_session: frontDeskCookie } });
    expect((list.json() as AppointmentRow[])[0].arrivedAt ?? null).toBeNull();

    // This visit sits at "now": cancel it so a rerun in the same minute finds the doctor's slot free (cancelled frees it).
    const freed = await app.inject({ method: "PATCH", url: `/appointments/${appt.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "cancel", reasonCode: "other" } });
    expect(freed.statusCode).toBe(200);
  });

  it("cannot complete an appointment that isn't currently with the doctor", async () => {
    const target = await freshScheduledAppointment();
    const res = await app.inject({ method: "PATCH", url: `/appointments/${target.id}/complete`, cookies: { pulseos_session: frontDeskCookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_with_doctor");
  });

  it("marking a no-show then rescheduling recovers it back to scheduled, both writing Timeline events", async () => {
    const target = await freshScheduledAppointment();

    const noShow = await app.inject({
      method: "PATCH", url: `/appointments/${target.id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action: "mark_no_show" },
    });
    expect(noShow.json().status).toBe("no_show");

    const newTime = futureSlot(7);
    const reschedule = await app.inject({
      method: "PATCH", url: `/appointments/${target.id}/reschedule`, cookies: { pulseos_session: frontDeskCookie }, payload: { scheduledAt: newTime, reasonCode: "patient_requested" },
    });
    expect(reschedule.statusCode).toBe(200);

    const timeline = await app.inject({ method: "GET", url: `/patients/${target.patientId}/timeline`, cookies: { pulseos_session: frontDeskCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("appointment_no_show");
    expect(eventTypes).toContain("appointment_rescheduled");
  });

  it("Add Appointment: creates a real appointment for an existing patient/journey and it shows up in the list + timeline", async () => {
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: frontDeskCookie } });
    const { branches, doctors } = lookups.json() as { branches: { id: string }[]; doctors: { id: string }[] };

    const lead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: frontDeskCookie },
      payload: { name: "New Appointment Flow", phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "GENERAL_OPD", branchId: branches[0].id, source: "walk_in", journeyType: "General Consultation" },
    });
    const { patientId, journeyId } = lead.json() as { patientId: string; journeyId: string };

    const scheduledAt = futureSlot(2);
    const create = await app.inject({
      method: "POST",
      url: "/appointments",
      cookies: { pulseos_session: frontDeskCookie },
      payload: { patientId, journeyId, branchId: branches[0].id, doctorId: doctors[0].id, scheduledAt, reason: "New patient consultation" },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as AppointmentRow;
    expect(created.status).toBe("scheduled");
    expect(created.patientId).toBe(patientId);

    const list = await app.inject({ method: "GET", url: "/appointments", cookies: { pulseos_session: frontDeskCookie } });
    expect((list.json() as AppointmentRow[]).some((a) => a.id === created.id)).toBe(true);

    const timeline = await app.inject({ method: "GET", url: `/patients/${patientId}/timeline`, cookies: { pulseos_session: frontDeskCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("appointment_created");
  });

  it("Add Appointment requires MANAGE_APPOINTMENTS, not just VIEW_APPOINTMENTS (Doctor is view-only)", async () => {
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: doctorCookie } });
    const { branches, doctors } = lookups.json() as { branches: { id: string }[]; doctors: { id: string }[] };
    const res = await app.inject({
      method: "POST",
      url: "/appointments",
      cookies: { pulseos_session: doctorCookie },
      payload: { patientId: "00000000-0000-0000-0000-000000000000", journeyId: "00000000-0000-0000-0000-000000000000", branchId: branches[0].id, doctorId: doctors[0].id, scheduledAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("MANAGE_APPOINTMENTS");
  });
});

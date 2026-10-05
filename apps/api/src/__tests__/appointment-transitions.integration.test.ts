import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, CreateLeadResult, Lookups } from "@pulseos/types";

// The same doctor cannot hold two visits in one minute, and these suites run against the shared seeded tenant (rows
// from earlier runs stay), so every future slot is a distinct, randomly placed minute within the next ~weeks.
let slotSeq = 0;
const futureSlot = (minDays = 1) => new Date(Date.now() + minDays * 86_400_000 + (Math.floor(Math.random() * 20_000) + ++slotSeq) * 60_000).toISOString();

// applyAppointmentAction previously only rejected acting on an already
// completed/cancelled appointment — it never checked that the requested
// action is a legal NEXT step from the appointment's CURRENT status. The
// frontend already only ever offers the single correct next action
// (AppointmentList.tsx's NEXT_ACTION map, AppointmentDrawer.tsx's CAN_*
// sets), so this was never reachable through the UI — but a direct API call
// could jump straight from "confirmed" to "with_doctor", skipping
// check-in/waiting entirely. This file locks the server down to the exact
// same canonical graph the frontend already encodes.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("appointment state machine — server-side transition enforcement (integration)", () => {
  let app: FastifyInstance;
  let frontDeskCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  async function freshAppointment(): Promise<AppointmentRow> {
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: frontDeskCookie } });
    const { branches, doctors } = lookups.json() as Lookups;

    const lead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: frontDeskCookie },
      payload: {
        name: "Transition Test Patient",
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

  async function act(id: string, action: string) {
    return app.inject({ method: "PATCH", url: `/appointments/${id}/action`, cookies: { pulseos_session: frontDeskCookie }, payload: { action, ...(action === "cancel" ? { reasonCode: "patient_requested" } : {}) } });
  }

  async function dbStatus(id: string): Promise<string> {
    const [row] = await db.select({ status: appointments.status }).from(appointments).where(eq(appointments.id, id));
    return row.status;
  }

  async function timelineEventTypes(patientId: string): Promise<string[]> {
    const res = await app.inject({ method: "GET", url: `/patients/${patientId}/timeline`, cookies: { pulseos_session: frontDeskCookie } });
    return (res.json() as { eventType: string }[]).map((e) => e.eventType);
  }

  it("rejects send_to_doctor from confirmed — skips check-in and waiting", async () => {
    const appt = await freshAppointment();
    const confirm = await act(appt.id, "confirm");
    expect(confirm.statusCode).toBe(200);

    const res = await act(appt.id, "send_to_doctor");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");

    // No silent partial mutation, no phantom Timeline event for a
    // transition that was actually rejected.
    expect(await dbStatus(appt.id)).toBe("confirmed");
    expect(await timelineEventTypes(appt.patientId)).not.toContain("appointment_with_doctor");
  });

  it("rejects mark_waiting from confirmed — skips check-in", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");

    const res = await act(appt.id, "mark_waiting");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await dbStatus(appt.id)).toBe("confirmed");
  });

  it("rejects confirm from waiting — cannot move backward in the flow", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");
    await act(appt.id, "check_in");
    await act(appt.id, "mark_waiting");

    const res = await act(appt.id, "confirm");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await dbStatus(appt.id)).toBe("waiting");
  });

  it("rejects check_in from waiting — already past check-in, cannot repeat it", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");
    await act(appt.id, "check_in");
    await act(appt.id, "mark_waiting");

    const res = await act(appt.id, "check_in");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await dbStatus(appt.id)).toBe("waiting");
  });

  it("rejects mark_no_show once already checked in — no-show only makes sense before arrival", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");
    await act(appt.id, "check_in");

    const res = await act(appt.id, "mark_no_show");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await dbStatus(appt.id)).toBe("checked_in");
  });

  it("allows the full canonical sequence in order (unchanged happy path)", async () => {
    const appt = await freshAppointment();
    expect((await act(appt.id, "confirm")).statusCode).toBe(200);
    expect((await act(appt.id, "check_in")).statusCode).toBe(200);
    expect((await act(appt.id, "mark_waiting")).statusCode).toBe(200);
    expect((await act(appt.id, "send_to_doctor")).statusCode).toBe(200);
    expect(await dbStatus(appt.id)).toBe("with_doctor");
  });

  it("allows cancel from any open pre-with_doctor state (confirmed)", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");
    const res = await act(appt.id, "cancel");
    expect(res.statusCode).toBe(200);
    expect(await dbStatus(appt.id)).toBe("cancelled");
  });

  it("rejects cancel once with_doctor — only Complete is valid from there", async () => {
    const appt = await freshAppointment();
    await act(appt.id, "confirm");
    await act(appt.id, "check_in");
    await act(appt.id, "mark_waiting");
    await act(appt.id, "send_to_doctor");

    const res = await act(appt.id, "cancel");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await dbStatus(appt.id)).toBe("with_doctor");
  });
});

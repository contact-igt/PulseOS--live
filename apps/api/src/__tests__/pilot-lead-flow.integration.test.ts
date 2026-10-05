import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { LeadsWorkspace, Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { connectors, journeys, patients, scheduleResources, tasks, timelineEvents } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The pilot's day-to-day lead path, checked through the real API with the real roles:
//   online lead -> contacted -> booked -> status;  walk-in;  duplicates;  original source;  no-show -> Appointment Risk -> My Work.
describe.skipIf(!DEMO_PASSWORD)("pilot lead flow (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let doctorResourceId: string;
  const phone = () => `+9190${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}`;
  // Every booking gets its own slot: the same doctor cannot be in two places (that is the booking rule under test elsewhere).
  let slot = 0;
  const nextSlot = (baseHours: number) => new Date(Date.now() + (baseHours + 0.5 * ++slot) * 3_600_000).toISOString();

  const call = (role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, cookies: { pulseos_session: t.cookie[role]! }, ...(payload ? { payload } : {}) });

  async function newLead(over: Record<string, unknown> = {}) {
    const res = await call("FRONT_DESK", "POST", "/leads", { name: "Pilot Patient", phone: phone(), specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", source: "google", ...over });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { patientId: string; journeyId: string; isNewPatient: boolean; appointmentId?: string };
  }
  async function row(journeyId: string) {
    const ws = (await call("FRONT_DESK", "GET", "/leads/workspace?view=all")).json() as LeadsWorkspace;
    return ws.rows.find((r) => r.id === journeyId);
  }
  const book = async (journeyId: string, patientId: string, at = nextSlot(48)) => {
    const res = await call("FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: t.branchId, doctorId: doctorResourceId, scheduledAt: at, reason: "Consultation" });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string };
  };
  const act = (id: string, action: string, extra: object = {}) => call("FRONT_DESK", "PATCH", `/appointments/${id}/action`, { action, ...extra });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    doctorResourceId = (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, t.userIds.DOCTOR!)))[0]!.id;
  });
  afterAll(async () => {
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  describe("online lead -> contacted -> booked -> status", () => {
    it("walks the canonical flow and the derived status follows it", async () => {
      const lead = await newLead({ source: "google" });
      let r = await row(lead.journeyId);
      expect(r).toMatchObject({ stage: "enquiry", operationalStatus: null, sourceLabel: "Google" });
      expect(["new", "uncontacted"]).toContain(r!.leadStatus);

      // A connected call: the lead is contacted.
      const logged = await call("FRONT_DESK", "POST", `/journeys/${lead.journeyId}/calls`, { direction: "outbound", connected: true, durationSeconds: 140 });
      expect(logged.statusCode, logged.body).toBe(201);
      r = await row(lead.journeyId);
      expect(r!.stage).toBe("contacted");

      // Booked: the lead status and the derived status both say so.
      const appt = await book(lead.journeyId, lead.patientId);
      r = await row(lead.journeyId);
      expect(r).toMatchObject({ leadStatus: "appointment_booked", operationalStatus: "appointment_booked" });
      expect(r!.nextAppointment?.id).toBe(appt.id);

      // Confirmed (e.g. by the WhatsApp reply or a call) -> a more specific derived status; the stage is not touched.
      expect((await act(appt.id, "confirm")).statusCode).toBe(200);
      r = await row(lead.journeyId);
      expect(r!.operationalStatus).toBe("appointment_confirmed");
    });

    it("the journey page and Patient 360 carry the same derived status as the lead row", async () => {
      const lead = await newLead();
      const appt = await book(lead.journeyId, lead.patientId);
      expect((await act(appt.id, "check_in")).statusCode).toBe(200);
      const detail = (await call("FRONT_DESK", "GET", `/journeys/${lead.journeyId}`)).json() as { journey: { operationalStatus: string | null } };
      expect(detail.journey.operationalStatus).toBe("checked_in");
      const p360 = (await call("FRONT_DESK", "GET", `/patients/${lead.patientId}/360`)).json() as { journeys: { id: string; operationalStatus: string | null }[] };
      expect(p360.journeys.find((j) => j.id === lead.journeyId)!.operationalStatus).toBe("checked_in");
      expect((await row(lead.journeyId))!.operationalStatus).toBe("checked_in");
      for (const [action, expected] of [["mark_waiting", "waiting"], ["send_to_doctor", "with_doctor"]] as const) {
        expect((await act(appt.id, action)).statusCode).toBe(200);
        expect((await row(lead.journeyId))!.operationalStatus, action).toBe(expected);
      }
    });
  });

  describe("walk-in", () => {
    it("creates the Patient, Journey and a first-contact line from the Walk-in source, with no invented callback", async () => {
      const lead = await newLead({ source: undefined, sourceKey: "walk_in", channel: "WALK_IN", name: "Walk In Person" });
      expect(lead.isNewPatient).toBe(true);
      expect((await db.select({ n: patients.name }).from(patients).where(eq(patients.id, lead.patientId)))[0]!.n).toBe("Walk In Person");
      const r = await row(lead.journeyId);
      expect(r).toMatchObject({ source: "walk_in", sourceLabel: "Walk-in" });
      const [first] = await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, lead.journeyId), eq(timelineEvents.eventType, "lead_created")));
      // One creation line: where they came from, then how it was captured (the channel is never invented from the source).
      expect(first).toMatchObject({ channel: "WALK_IN", description: "Source: Walk-in · Walk-in recorded manually" });
      // No callback, no follow-up, no call: nobody rang anybody.
      expect(await db.select().from(tasks).where(eq(tasks.journeyId, lead.journeyId))).toHaveLength(0);
      expect((await call("FRONT_DESK", "GET", `/patients/${lead.patientId}/360`)).json().calls).toHaveLength(0);
    });

    it("a walk-in can be booked on the spot and checked in straight away", async () => {
      const lead = await newLead({ source: undefined, sourceKey: "walk_in", channel: "WALK_IN", nextStep: { kind: "appointment", scheduledAt: nextSlot(1), doctorId: doctorResourceId } });
      expect(lead.appointmentId).toBeTruthy();
      expect((await act(lead.appointmentId!, "check_in")).statusCode).toBe(200);
      expect((await row(lead.journeyId))!.operationalStatus).toBe("checked_in");
    });
  });

  describe("duplicates and original source", () => {
    it("the same phone, however it is written, is the same Patient; a different service is a new Journey on that Patient", async () => {
      const number = phone();
      const national = number.replace("+91", "");
      const a = await newLead({ phone: number, name: "Same Person" });
      const b = await newLead({ phone: national, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", name: "Same Person" });
      const c = await newLead({ phone: `${number.slice(0, 3)} ${number.slice(3, 8)} ${number.slice(8)}`, journeyType: "Laser Vision Correction", specialtyKey: "LASER_VISION_CORRECTION" });
      expect(a.isNewPatient).toBe(true);
      expect([b.patientId, c.patientId]).toEqual([a.patientId, a.patientId]);
      expect(b.isNewPatient).toBe(false);
      expect(new Set([a.journeyId, b.journeyId, c.journeyId]).size).toBe(3);
      expect(await db.select().from(patients).where(and(eq(patients.tenantId, t.tenantId), eq(patients.phoneE164, number)))).toHaveLength(1);
      const lookup = (await call("FRONT_DESK", "POST", "/leads/lookup", { phone: national })).json() as { patient: { id: string; activeJourneyCount: number } | null };
      expect(lookup.patient).toMatchObject({ id: a.patientId, activeJourneyCount: 3 });
    });

    it("each journey keeps the source it started with, even when the patient comes back through another door", async () => {
      const number = phone();
      const first = await newLead({ phone: number, source: "google" });
      const second = await newLead({ phone: number, journeyType: "Oculoplasty", specialtyKey: "OCULOPLASTY", source: undefined, sourceKey: "instagram" });
      expect((await row(first.journeyId))).toMatchObject({ source: "google", sourceLabel: "Google" });
      expect((await row(second.journeyId))).toMatchObject({ source: "meta", sourceLabel: "Instagram" });
    });

    it("a website enquiry from a known patient adds a touch to the open journey and never rewrites its original source", async () => {
      const number = phone();
      const first = await newLead({ phone: number, source: "google" });
      const [connector] = await db.insert(connectors).values({ tenantId: t.tenantId, type: "ACQUISITION", provider: "website_form", status: "CONNECTED", displayName: "Website", capabilities: ["RECEIVE_FORM"], configuration: { formIds: ["f"] } }).returning();
      const res = await app.inject({ method: "POST", url: `/forms/website/${connector!.id}`, payload: { submissionId: `s-${Date.now()}`, formId: "f", name: "Same Person", phone: number, service: "Cataract" } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, journeyId: first.journeyId, deduped: true });
      const [j] = await db.select({ source: journeys.source }).from(journeys).where(eq(journeys.id, first.journeyId));
      expect(j!.source).toBe("google");
    });
  });

  describe("no-show -> Appointment Risk -> My Work", () => {
    it("raises ONE Appointment Risk follow-up for the owner, visible in My Work and on the lead, and never twice", async () => {
      const lead = await newLead({ ownerId: t.userIds.PATIENT_COORDINATOR });
      const appt = await book(lead.journeyId, lead.patientId);
      const first = await act(appt.id, "mark_no_show", { reasonCode: "patient_no_show" });
      expect(first.statusCode, first.body).toBe(200);
      expect((await act(appt.id, "mark_no_show", { reasonCode: "patient_no_show" })).statusCode).toBe(200); // repeat click: still one

      const open = await db.select().from(tasks).where(and(eq(tasks.journeyId, lead.journeyId), eq(tasks.status, "pending")));
      expect(open.filter((x) => x.type === "NO_SHOW_RECOVERY" || x.reason === "no_show")).toHaveLength(1);

      // My Work for the owner shows it.
      const mine = (await call("PATIENT_COORDINATOR", "GET", "/tasks?scope=mine")).json() as { rows?: { journeyId: string | null; typeLabel: string }[] } | { journeyId: string | null; typeLabel: string }[];
      const list = Array.isArray(mine) ? mine : (mine.rows ?? []);
      expect(list.some((x) => x.journeyId === lead.journeyId && /risk/i.test(x.typeLabel))).toBe(true);

      // The lead says what happened and what is next.
      const r = await row(lead.journeyId);
      expect(r).toMatchObject({ operationalStatus: "no_show" });
      expect(r!.nextAction?.label).toMatch(/risk/i);
    });

    it("a rebooked no-show is Appointment booked again", async () => {
      const lead = await newLead();
      const first = await book(lead.journeyId, lead.patientId);
      await act(first.id, "mark_no_show", { reasonCode: "patient_no_show" });
      expect((await row(lead.journeyId))!.operationalStatus).toBe("no_show");
      await book(lead.journeyId, lead.patientId, nextSlot(72));
      expect((await row(lead.journeyId))!.operationalStatus).toBe("appointment_booked");
    });
  });
});

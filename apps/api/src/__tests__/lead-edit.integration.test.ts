import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { and, eq } from "drizzle-orm";
import { journeys, patients } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, LeadEditModel, Lookups } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

const uniquePhone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

describe.skipIf(!DEMO_PASSWORD)("Edit Lead (integration)", () => {
  let app: FastifyInstance;
  let admin: string;
  let frontDesk: string;
  let doctor: string;
  let eyeAdmin: string;
  let branchId: string;
  let ownerId: string;

  const as = (cookie: string) => ({ pulseos_session: cookie });
  async function newLead(name = "Edit Lead Subject"): Promise<CreateLeadResult & { phone: string }> {
    const phone = uniquePhone();
    const res = await app.inject({ method: "POST", url: "/leads", cookies: as(admin), payload: { name, phone, specialtyKey: "GYNECOLOGY", branchId, sourceKey: "phone", journeyType: "Gynecology Consultation" } });
    expect(res.statusCode).toBe(201);
    return { ...(res.json() as CreateLeadResult), phone };
  }
  const model = async (cookie: string, journeyId: string) => (await app.inject({ method: "GET", url: `/leads/${journeyId}/edit`, cookies: as(cookie) })).json() as LeadEditModel;
  const patch = (cookie: string, journeyId: string, payload: unknown) => app.inject({ method: "PATCH", url: `/leads/${journeyId}`, cookies: as(cookie), payload: payload as object });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await loginAs(app, "gyn.admin@pulseos.local");
    frontDesk = await loginAs(app, "gyn.frontdesk@pulseos.local");
    doctor = await loginAs(app, "gyn.doctor@pulseos.local");
    eyeAdmin = await loginAs(app, "eye.admin@pulseos.local");
    const lookups = (await app.inject({ method: "GET", url: "/lookups", cookies: as(admin) })).json() as Lookups;
    branchId = lookups.branches[0].id;
    ownerId = lookups.owners[0].id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("opens with the current values and the caller's permissions", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    expect(m.patient.name).toBe("Edit Lead Subject");
    expect(m.journey.sourceKey).toBe("phone");
    expect(m.can).toEqual({ editPatient: true, editJourney: true, changeOwner: true, changeSource: true });
    expect((await model(frontDesk, lead.journeyId)).can).toEqual({ editPatient: true, editJourney: true, changeOwner: false, changeSource: false });
  });

  it("a Doctor (no MANAGE_LEADS) cannot open or save; another hospital's lead is a 404", async () => {
    const lead = await newLead();
    expect((await app.inject({ method: "GET", url: `/leads/${lead.journeyId}/edit`, cookies: as(doctor) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/leads/${lead.journeyId}/edit`, cookies: as(eyeAdmin) })).statusCode).toBe(404);
    const m = await model(admin, lead.journeyId);
    expect((await patch(eyeAdmin, lead.journeyId, { versions: m.versions, patient: { name: "Hijack" } })).statusCode).toBe(404);
  });

  it("saves patient and journey changes together and records them on the Timeline", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    const res = await patch(admin, lead.journeyId, { versions: m.versions, patient: { name: "Renamed Subject", email: "renamed@example.in" }, journey: { priority: "high", notes: "Prefers evenings" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changes: { field: string }[] }).changes.map((c) => c.field).sort()).toEqual(["email", "name", "notes", "priority"]);

    const after = await model(admin, lead.journeyId);
    expect(after.patient).toMatchObject({ name: "Renamed Subject", email: "renamed@example.in" });
    expect(after.journey).toMatchObject({ priority: "high", notes: "Prefers evenings" });

    const timeline = (await app.inject({ method: "GET", url: `/patients/${lead.patientId}/timeline`, cookies: as(admin) })).json() as { eventType: string }[];
    expect(timeline.map((e) => e.eventType)).toContain("lead_updated");
  });

  it("a save with nothing changed writes nothing", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    const res = await patch(admin, lead.journeyId, { versions: m.versions, patient: { name: "Edit Lead Subject" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changes: unknown[] }).changes).toEqual([]);
    expect((await model(admin, lead.journeyId)).versions).toEqual(m.versions);
  });

  it("refuses a save made on a stale copy (409) and keeps the newer values", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    expect((await patch(admin, lead.journeyId, { versions: m.versions, patient: { name: "First Save" } })).statusCode).toBe(200);
    const stale = await patch(frontDesk, lead.journeyId, { versions: m.versions, patient: { name: "Second Save" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("stale_version");
    expect((await model(admin, lead.journeyId)).patient.name).toBe("First Save");
  });

  it("is atomic: one invalid value rejects the whole save", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    const res = await patch(admin, lead.journeyId, { versions: m.versions, patient: { name: "Should Not Stick", email: "not-an-email" } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "invalid_field_values", fields: ["email"] });
    expect((await model(admin, lead.journeyId)).patient.name).toBe("Edit Lead Subject");
  });

  it("refuses a branch or owner from another hospital", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    const eyeLookups = (await app.inject({ method: "GET", url: "/lookups", cookies: as(eyeAdmin) })).json() as Lookups;
    const foreignBranch = await patch(admin, lead.journeyId, { versions: m.versions, patient: { branchId: eyeLookups.branches[0].id } });
    expect(foreignBranch.statusCode).toBe(422);
    const foreignOwner = await patch(admin, lead.journeyId, { versions: m.versions, journey: { ownerId: eyeLookups.owners[0].id } });
    expect(foreignOwner.statusCode).toBe(422);
  });

  it("Front Desk cannot change the owner or the source; an admin can, and a source change needs a reason", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    const owner = await patch(frontDesk, lead.journeyId, { versions: m.versions, journey: { ownerId } });
    expect(owner.statusCode).toBe(403);
    expect(owner.json().groups).toEqual(["owner"]);
    expect((await patch(frontDesk, lead.journeyId, { versions: m.versions, journey: { sourceKey: "google", sourceReason: "typo" } })).statusCode).toBe(403);

    const noReason = await patch(admin, lead.journeyId, { versions: m.versions, journey: { sourceKey: "google" } });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json().fields).toContain("sourceReason");

    const ok = await patch(admin, lead.journeyId, { versions: m.versions, journey: { sourceKey: "google", sourceReason: "Patient said they found us on Google" } });
    expect(ok.statusCode).toBe(200);
    const after = await model(admin, lead.journeyId);
    expect(after.journey.sourceKey).toBe("google");
    const timeline = (await app.inject({ method: "GET", url: `/patients/${lead.patientId}/timeline`, cookies: as(admin) })).json() as { eventType: string; description?: string }[];
    expect(timeline.find((e) => e.eventType === "lead_source_corrected")?.description).toContain("Google");
  });

  it("changing the phone moves the identity; a number another patient holds is refused with that patient named", async () => {
    const a = await newLead("Phone Subject A");
    const b = await newLead("Phone Subject B");
    const m = await model(admin, a.journeyId);

    const clash = await patch(admin, a.journeyId, { versions: m.versions, patient: { phone: b.phone } });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: "phone_in_use", patient: { id: b.patientId, name: "Phone Subject B" } });

    const fresh = uniquePhone();
    expect((await patch(admin, a.journeyId, { versions: m.versions, patient: { phone: fresh } })).statusCode).toBe(200);
    const [row] = await db.select({ phone: patients.phone }).from(patients).where(eq(patients.id, a.patientId));
    expect(row!.phone).toBe(fresh);
    // Add Lead with the new number now finds this same patient.
    const again = await app.inject({ method: "POST", url: "/leads", cookies: as(admin), payload: { phone: fresh, specialtyKey: "GYNECOLOGY", branchId, sourceKey: "phone", journeyType: "Gynecology Consultation" } });
    expect((again.json() as CreateLeadResult).patientId).toBe(a.patientId);
  });

  it("a stored journey keeps its tenant: the row never moves hospitals", async () => {
    const lead = await newLead();
    const m = await model(admin, lead.journeyId);
    await patch(admin, lead.journeyId, { versions: m.versions, journey: { priority: "high" }, tenantId: "00000000-0000-0000-0000-000000000000" });
    const [row] = await db.select({ tenantId: journeys.tenantId }).from(journeys).where(and(eq(journeys.id, lead.journeyId)));
    const [pat] = await db.select({ tenantId: patients.tenantId }).from(patients).where(eq(patients.id, lead.patientId));
    expect(row!.tenantId).toBe(pat!.tenantId);
  });
});

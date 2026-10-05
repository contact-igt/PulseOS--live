import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { marketingCampaigns, tenants, users } from "../db/schema.js";
import { eq, sum } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CustomFieldDefinitionVm, Patient360, SpecialtyTemplateVm, TimelineEventVm } from "@pulseos/types";

// Integration test: requires the DB seeded with `pnpm db:seed`, which creates
// two fully separate demo tenants — Gynecology and Ophthalmology.
//
// Isolation is proven through the real API with real sessions, never by
// inspecting a frontend filter: a user from one tenant is given the ID of a
// record from the other and must not be able to read or change it.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

type Cookie = string;

async function loginAs(app: FastifyInstance, email: string): Promise<Cookie> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  expect(res.statusCode, `login as ${email}`).toBe(200);
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

async function tenantIdByName(name: string): Promise<string> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, name));
  return row.id;
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: Cookie): Promise<T> {
  const res = await app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });
  expect(res.statusCode, `GET ${url}`).toBe(200);
  return res.json() as T;
}

interface JourneyRow { id: string; patientId: string; patientName: string; journeyType: string; specialtyKey?: string; campaignName: string | null }
interface TaskRow { id: string; status: string; patientId?: string | null }
interface CampaignRow { campaignId: string; campaignName: string; spend: number; leads: number }
interface TreatmentRow { id: string; status: string; treatmentLabel?: string; patientName?: string }
interface AppointmentRow { id: string; status: string }
interface ConversationRow { id: string; patientName?: string }

describe.skipIf(!DEMO_PASSWORD)("multi-specialty demo tenants (integration)", () => {
  let app: FastifyInstance;
  let gyn: { admin: Cookie; doctor: Cookie; frontdesk: Cookie; coordinator: Cookie };
  let eye: { admin: Cookie; doctor: Cookie; frontdesk: Cookie; coordinator: Cookie };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    gyn = {
      admin: await loginAs(app, "gyn.admin@pulseos.local"),
      doctor: await loginAs(app, "gyn.doctor@pulseos.local"),
      frontdesk: await loginAs(app, "gyn.frontdesk@pulseos.local"),
      coordinator: await loginAs(app, "gyn.coordinator@pulseos.local"),
    };
    eye = {
      admin: await loginAs(app, "eye.admin@pulseos.local"),
      doctor: await loginAs(app, "eye.doctor@pulseos.local"),
      frontdesk: await loginAs(app, "eye.frontdesk@pulseos.local"),
      coordinator: await loginAs(app, "eye.coordinator@pulseos.local"),
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // The attacker (a session from the other tenant) tries to modify the owner
  // tenant's records by ID. Each attempt must be refused AND the owner's state
  // read back unchanged — a status code alone would pass a half-applied write.
  async function expectCrossTenantWritesRejected(owner: { admin: Cookie }, attacker: { admin: Cookie }) {
    const tasks = (await getJson<TaskRow[]>(app, "/tasks", owner.admin)).filter((t) => t.status === "pending");
    expect(tasks.length).toBeGreaterThan(0);
    const task = tasks[0];
    const completeAttempt = await app.inject({ method: "PATCH", url: `/tasks/${task.id}/complete`, cookies: { pulseos_session: attacker.admin } });
    expect(completeAttempt.statusCode).toBe(404);
    expect((await getJson<TaskRow[]>(app, "/tasks", owner.admin)).find((t) => t.id === task.id)?.status).toBe("pending");

    const treatments = await getJson<TreatmentRow[]>(app, "/treatments", owner.admin);
    const treatment = treatments.find((t) => t.status === "DECISION_PENDING")!;
    const treatmentAttempt = await app.inject({
      method: "PATCH", url: `/treatments/${treatment.id}/status`, cookies: { pulseos_session: attacker.admin }, payload: { status: "DECLINED" },
    });
    expect([403, 404]).toContain(treatmentAttempt.statusCode);
    expect((await getJson<TreatmentRow[]>(app, "/treatments", owner.admin)).find((t) => t.id === treatment.id)?.status).toBe("DECISION_PENDING");

    const appointments = await getJson<AppointmentRow[]>(app, "/appointments", owner.admin);
    const confirmed = appointments.find((a) => a.status === "confirmed" || a.status === "scheduled");
    expect(confirmed, "owner tenant has an appointment that can be checked in").toBeDefined();
    const appointmentAttempt = await app.inject({
      method: "PATCH", url: `/appointments/${confirmed!.id}/action`, cookies: { pulseos_session: attacker.admin }, payload: { action: "check_in" },
    });
    expect([403, 404]).toContain(appointmentAttempt.statusCode);
    expect((await getJson<AppointmentRow[]>(app, "/appointments", owner.admin)).find((a) => a.id === confirmed!.id)?.status).toBe(confirmed!.status);

    const conversations = await getJson<ConversationRow[]>(app, "/conversations", owner.admin);
    const conversationAttempt = await app.inject({ method: "GET", url: `/conversations/${conversations[0].id}`, cookies: { pulseos_session: attacker.admin } });
    expect(conversationAttempt.statusCode).toBe(404);
    const closeAttempt = await app.inject({ method: "PATCH", url: `/conversations/${conversations[0].id}/close`, cookies: { pulseos_session: attacker.admin } });
    expect([403, 404]).toContain(closeAttempt.statusCode);
  }

  describe("seeding", () => {
    it("has exactly one Gynecology and one Ophthalmology demo tenant, no duplicates", async () => {
      const rows = await db.select({ name: tenants.name }).from(tenants);
      expect(rows.filter((r) => r.name === "PulseOS Gynecology Demo")).toHaveLength(1);
      expect(rows.filter((r) => r.name === "PulseOS Ophthalmology Demo")).toHaveLength(1);
    });

    it("every role has a demo user in each tenant, and no email is duplicated", async () => {
      const all = (await db.select({ email: users.email, tenantId: users.tenantId, role: users.role }).from(users)).filter((u) => /^(gyn|eye)\./.test(u.email));
      const emails = all.map((u) => u.email);
      expect(new Set(emails).size).toBe(emails.length); // each demo email exists exactly once
      for (const prefix of ["gyn", "eye"]) {
        for (const slug of ["admin", "doctor", "frontdesk", "coordinator"]) {
          expect(emails).toContain(`${prefix}.${slug}@pulseos.local`);
        }
      }
      const tenantOf = (email: string) => all.find((u) => u.email === email)!.tenantId;
      expect(tenantOf("gyn.admin@pulseos.local")).toBe(tenantOf("gyn.doctor@pulseos.local"));
      expect(tenantOf("eye.admin@pulseos.local")).toBe(tenantOf("eye.coordinator@pulseos.local"));
      expect(tenantOf("gyn.admin@pulseos.local")).not.toBe(tenantOf("eye.admin@pulseos.local"));
    });

    it("demo logins land in the tenant they belong to", async () => {
      const gynSession = await getJson<{ user: { tenantId: string; role: string } }>(app, "/auth/session", gyn.admin);
      const eyeSession = await getJson<{ user: { tenantId: string; role: string } }>(app, "/auth/session", eye.doctor);
      expect(gynSession.user.tenantId).toBe(await tenantIdByName("PulseOS Gynecology Demo"));
      expect(gynSession.user.role).toBe("HOSPITAL_ADMIN");
      expect(eyeSession.user.tenantId).toBe(await tenantIdByName("PulseOS Ophthalmology Demo"));
      expect(eyeSession.user.role).toBe("DOCTOR");
    });
  });

  describe("specialty configuration drives Add Lead", () => {
    it("the Ophthalmology tenant offers the five eye services plus General Eye Consultation — and no gynecology", async () => {
      const list = await getJson<SpecialtyTemplateVm[]>(app, "/specialties", eye.coordinator);
      const keys = list.map((s) => s.key);
      expect(keys).toEqual(expect.arrayContaining(["CATARACT", "OCULOPLASTY", "LASER_VISION_CORRECTION", "SQUINT", "KERATOCONUS", "GENERAL_EYE_CONSULTATION"]));
      expect(keys).not.toContain("GYNECOLOGY");
      expect(keys).not.toContain("FERTILITY");
      expect(list.find((s) => s.key === "LASER_VISION_CORRECTION")?.displayName).toBe("Laser Vision Correction");
    });

    it("the Gynecology tenant offers women's-health specialties — and no ophthalmology", async () => {
      const list = await getJson<SpecialtyTemplateVm[]>(app, "/specialties", gyn.coordinator);
      const keys = list.map((s) => s.key);
      expect(keys).toEqual(expect.arrayContaining(["GYNECOLOGY", "FERTILITY"]));
      expect(keys.some((k) => ["CATARACT", "OCULOPLASTY", "LASER_VISION_CORRECTION", "SQUINT"].includes(k))).toBe(false);
    });

    it("Cataract Add Lead fields are the common eye fields plus the cataract-specific ones", async () => {
      const fields = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/CATARACT/fields", eye.coordinator);
      const labels = fields.map((f) => f.label);
      expect(labels).toEqual(expect.arrayContaining(["Primary eye concern", "Laterality", "Diabetes", "Recorded cataract status", "Surgery advised", "Surgery interest"]));
      expect(fields.find((f) => f.key === "cataract_surgery_interest")?.options).toEqual(["Considering", "Ready to schedule", "Needs counselling"]);
      expect(labels).not.toContain("Squint type");
    });

    it("each service exposes its own fields", async () => {
      const oculo = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/OCULOPLASTY/fields", eye.coordinator);
      expect(oculo.find((f) => f.key === "oculoplasty_concern")?.options).toEqual(["Ptosis", "Eyelid swelling", "Tear duct problem", "Under-eye concern", "Eyelid lesion", "Other"]);
      const laser = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/LASER_VISION_CORRECTION/fields", eye.coordinator);
      expect(laser.find((f) => f.key === "lvc_interest")?.options).toEqual(["LASIK", "SMILE", "PRK", "Not sure"]);
      expect(laser.find((f) => f.key === "lvc_eligible")?.options).toEqual(["Yes", "No", "Pending evaluation"]);
      const squint = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/SQUINT/fields", eye.coordinator);
      expect(squint.find((f) => f.key === "squint_previous_treatment")?.options).toEqual(["Glasses", "Patching", "Surgery", "None"]);
    });

    it("Keratoconus exposes coordinator-level fields only (recorded status, eye, history, screening, CXL advised)", async () => {
      const kc = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/KERATOCONUS/fields", eye.coordinator);
      expect(kc.find((f) => f.key === "keratoconus_status")?.options).toEqual(["Suspected", "Confirmed"]);
      expect(kc.find((f) => f.key === "keratoconus_eye")?.options).toEqual(["Right", "Left", "Both"]);
      for (const key of ["eye_rubbing_history", "topography_done", "cxl_advised"]) expect(kc.find((f) => f.key === key)?.options).toEqual(["Yes", "No"]);
      expect(kc.map((f) => f.label)).toContain("Primary eye concern");
    });

    it("the Gynecology tenant has no fields for an eye specialty key — configuration never crosses tenants", async () => {
      const fields = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/CATARACT/fields", gyn.coordinator);
      expect(fields).toEqual([]);
      const gynFields = await getJson<CustomFieldDefinitionVm[]>(app, "/specialties/GYNECOLOGY/fields", eye.coordinator);
      expect(gynFields).toEqual([]);
    });
  });

  describe("Ophthalmology demo data", () => {
    let eyeJourneys: JourneyRow[];

    beforeAll(async () => {
      eyeJourneys = await getJson<JourneyRow[]>(app, "/journeys", eye.admin);
    });

    it.each([
      ["Cataract", "CATARACT"],
      ["Oculoplasty", "OCULOPLASTY"],
      ["Laser Vision Correction", "LASER_VISION_CORRECTION"],
      ["Squint", "SQUINT"],
    ])("has %s Journeys that keep their service type", (journeyType) => {
      const rows = eyeJourneys.filter((j) => j.journeyType === journeyType);
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it("contains no gynecology journey types", () => {
      const types = new Set(eyeJourneys.map((j) => j.journeyType));
      for (const gynType of ["Fertility", "Pregnancy Care", "Gynecology Consultation"]) expect(types.has(gynType)).toBe(false);
    });

    it("Patient 360 for the right-eye cataract patient shows the ophthalmology fields, communications and treatment", async () => {
      const journey = eyeJourneys.find((j) => j.patientName === "Ramesh Hegde" && j.journeyType === "Cataract")!;
      expect(journey).toBeDefined();
      const p360 = await getJson<Patient360>(app, `/patients/${journey.patientId}/360`, eye.admin);
      const cataractJourney = p360.journeys.find((j) => j.id === journey.id)!;
      expect(cataractJourney.customFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "Laterality", value: "Right" }),
          expect.objectContaining({ label: "Recorded cataract status", value: "Confirmed" }),
          expect.objectContaining({ label: "Surgery advised", value: "Yes" }),
        ]),
      );
      expect(p360.calls.length).toBeGreaterThanOrEqual(2);
      const timeline = await getJson<TimelineEventVm[]>(app, `/patients/${journey.patientId}/timeline`, eye.admin);
      const timelineTitles = timeline.map((t) => t.title);
      expect(timelineTitles.some((t) => t.includes("Cataract journey opened"))).toBe(true);
      expect(timelineTitles.some((t) => t.startsWith("WhatsApp conversation"))).toBe(true);
      expect(timelineTitles.some((t) => t.startsWith("Treatment \"Cataract Surgery"))).toBe(true);
    });

    it("treatments cover the four service groups across the treatment state machine", async () => {
      const treatments = await getJson<{ treatmentLabel: string; status: string; patientName: string; plannedDate: string | null }[]>(app, "/treatments", eye.admin);
      const byLabel = (label: string) => treatments.filter((t) => t.treatmentLabel.startsWith(label));
      expect(byLabel("Ptosis Correction")[0]).toMatchObject({ patientName: "Kavitha Prakash", status: "SCHEDULED" });
      expect(byLabel("Ptosis Correction")[0].plannedDate).not.toBeNull();
      expect(byLabel("Cataract Surgery — Right Eye").some((t) => t.status === "DECISION_PENDING" && t.patientName === "Ramesh Hegde")).toBe(true);
      expect(byLabel("DCR / Tear Duct Procedure")[0].status).toBe("COMPLETED");
      expect(byLabel("SMILE")[0].status).toBe("COMPLETED");
      expect(byLabel("LASIK")[0].status).toBe("DECLINED");
      expect(byLabel("Squint Surgery").map((t) => t.status)).toEqual(expect.arrayContaining(["ACCEPTED", "DECISION_PENDING"]));
      expect([...new Set(treatments.map((t) => t.status))]).toEqual(expect.arrayContaining(["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED", "DECLINED"]));
    });

    it("every one of the eight ophthalmology procedures appears as a catalog-linked treatment", async () => {
      const catalog = await getJson<{ id: string; key: string; label: string }[]>(app, "/treatment-catalog", eye.admin);
      expect(catalog.map((c) => c.key).sort()).toEqual(["CATARACT_SURGERY", "CXL", "DCR", "LASIK", "PRK", "PTOSIS_CORRECTION", "SMILE", "SQUINT_SURGERY"]);
      const treatments = await getJson<{ treatmentDefinitionId: string | null; treatmentLabel: string }[]>(app, "/treatments", eye.admin);
      expect(treatments.every((t) => t.treatmentDefinitionId !== null)).toBe(true);
      for (const def of catalog) expect(treatments.some((t) => t.treatmentDefinitionId === def.id), def.label).toBe(true);
    });

    it("has Keratoconus journeys: one advised CXL with a pending follow-up, one at enquiry", async () => {
      const kc = eyeJourneys.filter((j) => j.journeyType === "Keratoconus");
      expect(kc.length).toBeGreaterThanOrEqual(2);
      const treatments = await getJson<{ patientName: string; treatmentLabel: string; status: string; journeyId: string }[]>(app, "/treatments", eye.admin);
      const cxl = treatments.filter((t) => t.treatmentLabel.startsWith("Corneal Cross-Linking"));
      expect(cxl.length).toBeGreaterThanOrEqual(1);
      expect(cxl.some((t) => t.status === "ADVISED" && kc.some((j) => j.id === t.journeyId))).toBe(true);
      const tasks = await getJson<TaskRow[]>(app, "/tasks", eye.admin);
      const advisedPatient = kc.find((j) => cxl.some((t) => t.journeyId === j.id))!.patientId;
      expect(tasks.some((t) => t.patientId === advisedPatient && t.status === "pending")).toBe(true);
    });

    it("a Laser Vision Correction patient is deciding on PRK (decision pending)", async () => {
      const treatments = await getJson<{ patientName: string; treatmentLabel: string; status: string }[]>(app, "/treatments", eye.admin);
      expect(treatments.some((t) => t.treatmentLabel === "PRK" && t.status === "DECISION_PENDING")).toBe(true);
    });

    it("follow-up tasks are specific to each eye service and sit with the right owner", async () => {
      const coordinatorTasks = await getJson<{ patientName: string; type: string; notes: string | null; status: string }[]>(app, "/tasks", eye.coordinator);
      const forPatient = (name: string) => coordinatorTasks.filter((t) => t.patientName === name && t.status === "pending");
      expect(forPatient("Ramesh Hegde")[0].type).toBe("TREATMENT_DECISION");
      expect(forPatient("Nisha Bhandari")[0]).toMatchObject({ type: "CALLBACK" });
      expect(forPatient("Kavitha Prakash")[0].notes).toMatch(/ptosis/i);
      expect(forPatient("Aarav Deshpande")[0].notes).toMatch(/squint/i);
      const frontDeskTasks = await getJson<{ patientName: string; type: string }[]>(app, "/tasks", eye.frontdesk);
      expect(frontDeskTasks.some((t) => t.patientName === "Manjunath Shetty" && t.type === "CALLBACK")).toBe(true);
    });

    it("calls and WhatsApp threads seeded for the eye tenant read as ophthalmology conversations", async () => {
      const p = (await getJson<{ id: string; name: string }[]>(app, "/patients?search=Ramesh", eye.admin)).find((x) => x.name === "Ramesh Hegde")!;
      const p360 = await getJson<Patient360>(app, `/patients/${p.id}/360`, eye.admin);
      // The seeded call names its line; the IVR call added by the call demo story honestly has none (several lines are active).
      const inbound = p360.calls.filter((c) => c.direction === "inbound");
      expect(inbound.map((c) => c.endpointLabel)).toContain("Cataract Enquiry Line");
      const timeline = await getJson<TimelineEventVm[]>(app, `/patients/${p.id}/timeline`, eye.admin);
      expect(timeline.map((t) => t.description ?? "").join(" ")).toContain("Can I send my previous eye reports before the appointment?");
    });
  });

  describe("tenant isolation — Ophthalmology user cannot reach Gynecology records", () => {
    it("cannot open a Gynecology patient by direct ID", async () => {
      const gynPatients = await getJson<{ id: string }[]>(app, "/patients?search=Priya", gyn.admin);
      expect(gynPatients.length).toBeGreaterThan(0);
      const res = await app.inject({ method: "GET", url: `/patients/${gynPatients[0].id}/360`, cookies: { pulseos_session: eye.admin } });
      expect(res.statusCode).toBe(404);
      const timeline = await app.inject({ method: "GET", url: `/patients/${gynPatients[0].id}/timeline`, cookies: { pulseos_session: eye.admin } });
      expect(timeline.json()).toEqual([]);
    });

    it("cannot see Gynecology patients in search, journeys, tasks, appointments, treatments, conversations or campaigns", async () => {
      const search = await getJson<{ name: string }[]>(app, "/patients?search=Priya", eye.admin);
      expect(search).toEqual([]);
      const journeys = await getJson<JourneyRow[]>(app, "/journeys", eye.admin);
      expect(journeys.some((j) => ["Fertility", "Pregnancy Care"].includes(j.journeyType))).toBe(false);
      const campaigns = await getJson<CampaignRow[]>(app, "/campaigns/performance", eye.admin);
      expect(campaigns.some((c) => /Fertility|IVF|Antenatal/.test(c.campaignName))).toBe(false);
      const conversations = await getJson<ConversationRow[]>(app, "/conversations", eye.admin);
      expect(conversations.some((c) => c.patientName === "Priya Sharma")).toBe(false);
    });

    it("cannot change a Gynecology task, treatment, appointment or conversation by ID — and nothing changes", async () => {
      await expectCrossTenantWritesRejected(gyn, eye);
    });
  });

  describe("tenant isolation — Gynecology user cannot reach Ophthalmology records", () => {
    it("cannot open an Ophthalmology patient by direct ID", async () => {
      const eyePatients = await getJson<{ id: string }[]>(app, "/patients?search=Ramesh", eye.admin);
      expect(eyePatients.length).toBeGreaterThan(0);
      const res = await app.inject({ method: "GET", url: `/patients/${eyePatients[0].id}/360`, cookies: { pulseos_session: gyn.admin } });
      expect(res.statusCode).toBe(404);
    });

    it("cannot see Ophthalmology patients, journeys or campaigns", async () => {
      expect(await getJson<unknown[]>(app, "/patients?search=Ramesh", gyn.admin)).toEqual([]);
      const journeys = await getJson<JourneyRow[]>(app, "/journeys", gyn.admin);
      expect(journeys.some((j) => ["Cataract", "Oculoplasty", "Laser Vision Correction", "Squint"].includes(j.journeyType))).toBe(false);
      const campaigns = await getJson<CampaignRow[]>(app, "/campaigns/performance", gyn.admin);
      expect(campaigns.some((c) => /Cataract|LASIK|Ptosis|Squint/.test(c.campaignName))).toBe(false);
    });

    it("cannot change an Ophthalmology task, treatment, appointment or conversation by ID — and nothing changes", async () => {
      await expectCrossTenantWritesRejected(eye, gyn);
    });
  });

  describe("dashboards read only the current tenant", () => {
    it("Marketing Spend equals the sum of that tenant's own campaigns", async () => {
      for (const [cookie, tenantName] of [[gyn.admin, "PulseOS Gynecology Demo"], [eye.admin, "PulseOS Ophthalmology Demo"]] as const) {
        const dash = await getJson<{ marketingSpend: number }>(app, "/dashboard/executive", cookie);
        const [row] = await db.select({ total: sum(marketingCampaigns.spendAmount) }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, await tenantIdByName(tenantName)));
        expect(dash.marketingSpend).toBe(Number(row.total));
      }
      // Ophthalmology's seeded campaigns alone add up to at least this — nothing from the gynecology tenant is mixed in.
      const eyeDash = await getJson<{ marketingSpend: number }>(app, "/dashboard/executive", eye.admin);
      expect(eyeDash.marketingSpend).toBeGreaterThanOrEqual(166_000);
    });

    it("the two tenants report different campaign sets and different spend", async () => {
      const gynCampaigns = (await getJson<CampaignRow[]>(app, "/campaigns/performance", gyn.admin)).map((c) => c.campaignName);
      const eyeCampaigns = (await getJson<CampaignRow[]>(app, "/campaigns/performance", eye.admin)).map((c) => c.campaignName);
      expect(eyeCampaigns).toEqual(expect.arrayContaining([
        "Cataract Consultation — Google Search",
        "Cataract Surgery Enquiries — Meta",
        "LASIK / Laser Vision Correction — Google",
        "Ptosis / Oculoplasty Consultation — Meta",
        "Squint Consultation — Meta",
      ]));
      expect(eyeCampaigns.filter((n) => gynCampaigns.includes(n))).toEqual([]);
    });

    it("Ophthalmology campaigns have spend, leads and completed-treatment revenue where the story calls for it", async () => {
      const rows = await getJson<(CampaignRow & { revenue: number; treatmentCompleted: number; roas: number | null })[]>(app, "/campaigns/performance", eye.admin);
      const cataractGoogle = rows.find((r) => r.campaignName === "Cataract Consultation — Google Search")!;
      expect(cataractGoogle.spend).toBe(38_000);
      expect(cataractGoogle.leads).toBeGreaterThan(0);
      expect(cataractGoogle.revenue).toBeGreaterThan(0);
      expect(cataractGoogle.roas).not.toBeNull();
    });

    it("Doctor Home in the Ophthalmology tenant only lists eye patients", async () => {
      const home = await getJson<unknown>(app, "/dashboard/doctor", eye.doctor);
      const text = JSON.stringify(home);
      for (const eyePatient of ["Anil Joshi", "Zoya Khan", "Harish Bhat"]) expect(text).toContain(eyePatient);
      for (const gynName of ["Priya Sharma", "Sneha Reddy", "Fertility", "IVF"]) expect(text).not.toContain(gynName);
    });
  });
});

// Dev Login, per environment. Built per case with the env flag on, exactly as
// dev-login.integration.test.ts does, because the routes only exist when
// registered under that flag.
describe.skipIf(!DEMO_PASSWORD)("Dev Login demo environments (integration)", () => {
  async function devApp(): Promise<FastifyInstance> {
    const prev = process.env.ENABLE_DEV_LOGIN;
    const prevEnv = process.env.NODE_ENV;
    process.env.ENABLE_DEV_LOGIN = "true";
    process.env.NODE_ENV = "test";
    const built = await buildApp();
    await built.ready();
    if (prev === undefined) delete process.env.ENABLE_DEV_LOGIN;
    else process.env.ENABLE_DEV_LOGIN = prev;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    return built;
  }

  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await queryClient.end();
  });

  it("lists the demo environments", async () => {
    const built = await devApp();
    apps.push(built);
    const res = await built.inject({ method: "GET", url: "/auth/dev-login/environments" });
    expect(res.statusCode).toBe(200);
    // Read from the database now: the seeded demos (each with the roles that really have an account) first, then any
    // hospital that signed up in development ("tenant:<id>").
    const envs = res.json() as { key: string; label: string; roles: { role: string }[] }[];
    const seeded = envs.filter((e) => !e.key.startsWith("tenant:"));
    expect(seeded.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: "gynecology", label: "Gynecology V2" },
      { key: "ophthalmology", label: "Ophthalmology V2" },
      { key: "ophthalmology-v1", label: "Ophthalmology V1" },
      { key: "namokar", label: "Namokar V1 Demo" },
      { key: "namokar-v2", label: "Namokar V2 Pilot" },
    ]);
    for (const e of seeded) expect(e.roles.length).toBeGreaterThan(0);
    // Namokar's owner is a (tenant-scoped) Super Admin, like every other demo hospital's.
    expect(seeded.find((e) => e.key === "namokar")!.roles.map((r) => r.role)).toEqual(["SUPER_ADMIN", "HOSPITAL_ADMIN", "DOCTOR", "FRONT_DESK", "PATIENT_COORDINATOR"]);
    expect(seeded.find((e) => e.key === "gynecology")!.roles.map((r) => r.role)).toContain("SUPER_ADMIN");
  });

  it.each([
    ["gynecology", "PulseOS Gynecology Demo", "gyn"],
    ["ophthalmology", "PulseOS Ophthalmology Demo", "eye"],
  ])("signs in as each of the four roles in the %s environment, in that environment's own tenant", async (environment, tenantName, prefix) => {
    const built = await devApp();
    apps.push(built);
    for (const [role, slug] of [["HOSPITAL_ADMIN", "admin"], ["DOCTOR", "doctor"], ["FRONT_DESK", "frontdesk"], ["PATIENT_COORDINATOR", "coordinator"]]) {
      const login = await built.inject({ method: "POST", url: "/auth/dev-login", payload: { role, environment } });
      expect(login.statusCode, `${environment}/${role}`).toBe(200);
      const body = login.json() as { user: { email: string; tenantId: string; tenantName: string; role: string } };
      expect(body.user.tenantName).toBe(tenantName);
      expect(body.user.email).toBe(`${prefix}.${slug}@pulseos.local`);
      expect(body.user.role).toBe(role);
      const cookie = login.cookies.find((c) => c.name === "pulseos_session")!;
      const session = await built.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie.value } });
      expect((session.json() as { user: { tenantId: string } }).user.tenantId).toBe(body.user.tenantId);
      expect(body.user.tenantId).toBe(await tenantIdByName(tenantName));
    }
  });

  it("a Dev Login session is a normal session: an Ophthalmology dev session cannot read Gynecology data", async () => {
    const built = await devApp();
    apps.push(built);
    const eyeLogin = await built.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN", environment: "ophthalmology" } });
    const eyeCookie = eyeLogin.cookies.find((c) => c.name === "pulseos_session")!.value;
    const gynLogin = await built.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN", environment: "gynecology" } });
    const gynCookie = gynLogin.cookies.find((c) => c.name === "pulseos_session")!.value;
    const gynPatients = (await built.inject({ method: "GET", url: "/patients?search=Priya", cookies: { pulseos_session: gynCookie } })).json() as { id: string }[];
    expect(gynPatients.length).toBeGreaterThan(0);
    const cross = await built.inject({ method: "GET", url: `/patients/${gynPatients[0].id}/360`, cookies: { pulseos_session: eyeCookie } });
    expect(cross.statusCode).toBe(404);
  });

  it("defaults to the Gynecology environment when none is given, and rejects an unknown environment", async () => {
    const built = await devApp();
    apps.push(built);
    const dflt = await built.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN" } });
    expect((dflt.json() as { user: { tenantName: string } }).user.tenantName).toBe("PulseOS Gynecology Demo");
    const bad = await built.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "HOSPITAL_ADMIN", environment: "cardiology" } });
    expect(bad.statusCode).toBe(400);
  });

  it("the environment list is absent when Dev Login is disabled", async () => {
    const prev = process.env.ENABLE_DEV_LOGIN;
    delete process.env.ENABLE_DEV_LOGIN;
    const built = await buildApp();
    await built.ready();
    if (prev !== undefined) process.env.ENABLE_DEV_LOGIN = prev;
    apps.push(built);
    const res = await built.inject({ method: "GET", url: "/auth/dev-login/environments" });
    expect(res.statusCode).toBe(404);
    // Sanity: the tenant table lookup used above still resolves.
    expect(await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, "PulseOS Gynecology Demo"))).toHaveLength(1);
  });
});

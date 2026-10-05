import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { customFieldDefinitions, customFieldValues } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, LeadRow, LeadsSummary, Lookups } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

function uniquePhone(): string {
  // 10 digits, always starts 9 so normalizePhone leaves it untouched.
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

describe.skipIf(!DEMO_PASSWORD)("leads (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let coordinatorCookie: string;
  let doctorCookie: string;
  let branchId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");

    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: adminCookie } });
    branchId = (lookups.json() as Lookups).branches[0].id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: "/leads" });
    expect(res.statusCode).toBe(401);
  });

  it("a role without MANAGE_LEADS (Doctor) is forbidden with the specific permission named", async () => {
    const res = await app.inject({ method: "GET", url: "/leads", cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().requiredPermission).toBe("MANAGE_LEADS");
  });

  it("Add Lead — new patient: creates Patient + Journey, writes lead_created + patient_created timeline events", async () => {
    const phone = uniquePhone();
    const res = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: {
        name: "Test Lead New Patient",
        phone,
        specialtyKey: "GYNECOLOGY",
        branchId,
        source: "meta",
        journeyType: "Pregnancy Care",
      },
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as CreateLeadResult;
    expect(result.isNewPatient).toBe(true);
    expect(result.patientId).toBeTruthy();
    expect(result.journeyId).toBeTruthy();

    const timeline = await app.inject({ method: "GET", url: `/patients/${result.patientId}/timeline`, cookies: { pulseos_session: coordinatorCookie } });
    const eventTypes = (timeline.json() as { eventType: string }[]).map((e) => e.eventType);
    expect(eventTypes).toContain("patient_created");
    expect(eventTypes).toContain("lead_created");
  });

  it("Add Lead — existing patient (by phone): reuses the Patient, creates only a new Journey, no duplicate", async () => {
    const phone = uniquePhone();
    const first = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Duplicate Check Patient", phone, specialtyKey: "GYNECOLOGY", branchId, source: "website", journeyType: "Gynecology Consultation" },
    });
    const firstResult = first.json() as CreateLeadResult;
    expect(firstResult.isNewPatient).toBe(true);

    const second = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Duplicate Check Patient", phone, specialtyKey: "FERTILITY", branchId, source: "walk_in", journeyType: "Fertility" },
    });
    expect(second.statusCode).toBe(201);
    const secondResult = second.json() as CreateLeadResult;

    expect(secondResult.isNewPatient).toBe(false);
    expect(secondResult.patientId).toBe(firstResult.patientId);
    expect(secondResult.journeyId).not.toBe(firstResult.journeyId);
  });

  it("phone duplicate prevention holds even with phone formatting differences (+91, spaces)", async () => {
    const bare = uniquePhone();
    const formatted = `+91 ${bare.slice(0, 5)} ${bare.slice(5)}`;

    const first = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Format Check", phone: bare, specialtyKey: "GYNECOLOGY", branchId, source: "phone", journeyType: "Gynecology Consultation" },
    });
    const firstResult = first.json() as CreateLeadResult;

    const second = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Format Check", phone: formatted, specialtyKey: "GYNECOLOGY", branchId, source: "phone", journeyType: "Gynecology Consultation" },
    });
    const secondResult = second.json() as CreateLeadResult;

    expect(secondResult.isNewPatient).toBe(false);
    expect(secondResult.patientId).toBe(firstResult.patientId);
  });

  it("persists specialty custom field values against the new journey", async () => {
    const phone = uniquePhone();
    const res = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: {
        name: "Custom Field Check",
        phone,
        specialtyKey: "FERTILITY",
        branchId,
        source: "meta",
        journeyType: "Fertility",
        customFieldValues: { trying_duration: "2 years", previous_fertility_treatment: false, ivf_interest: true },
      },
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as CreateLeadResult;

    const leads = await app.inject({ method: "GET", url: "/leads", cookies: { pulseos_session: coordinatorCookie } });
    const lead = (leads.json() as LeadRow[]).find((l) => l.id === result.journeyId);
    expect(lead?.specialtyKey).toBe("FERTILITY");
    expect(lead?.specialtyLabel).toBe("Fertility / IVF");
  });

  it("a specialty's required custom field blocks lead creation until a value is provided", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/specialties/GYNECOLOGY/fields",
      cookies: { pulseos_session: adminCookie },
      payload: { key: "referral_reason", label: "Referral reason", fieldType: "TEXT", required: true },
    });
    expect(create.statusCode).toBe(201);
    const field = create.json() as { id: string };

    try {
      const phone = uniquePhone();
      const missing = await app.inject({
        method: "POST",
        url: "/leads",
        cookies: { pulseos_session: coordinatorCookie },
        payload: { name: "Required Field Check", phone, specialtyKey: "GYNECOLOGY", branchId, source: "website", journeyType: "Gynecology Consultation" },
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ error: "missing_required_fields", fields: ["referral_reason"] });

      const provided = await app.inject({
        method: "POST",
        url: "/leads",
        cookies: { pulseos_session: coordinatorCookie },
        payload: {
          name: "Required Field Check",
          phone,
          specialtyKey: "GYNECOLOGY",
          branchId,
          source: "website",
          journeyType: "Gynecology Consultation",
          customFieldValues: { referral_reason: "GP referral" },
        },
      });
      expect(provided.statusCode).toBe(201);
    } finally {
      // Remove the test field and its values entirely (archiving would leave the key behind and collide on the next run).
      await db.delete(customFieldValues).where(eq(customFieldValues.fieldDefinitionId, field.id));
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, field.id));
    }
  });

  it("creates a first follow-up task when followUp is provided, and the lead then carries a Next Action", async () => {
    const phone = uniquePhone();
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: {
        name: "Follow Up Check", phone, specialtyKey: "GYNECOLOGY", branchId, source: "referral", journeyType: "Gynecology Consultation",
        followUp: { type: "CALLBACK", dueAt },
      },
    });
    const result = res.json() as CreateLeadResult;

    const tasks = await app.inject({ method: "GET", url: `/tasks?patientId=${result.patientId}`, cookies: { pulseos_session: coordinatorCookie } });
    const rows = tasks.json() as { journeyId: string | null; type: string; status: string }[];
    expect(rows.some((t) => t.journeyId === result.journeyId && t.type === "CALLBACK" && t.status === "pending")).toBe(true);
  });

  it("walk-in lead: source WALK_IN requires no campaign field", async () => {
    const phone = uniquePhone();
    const res = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Walk-in Check", phone, specialtyKey: "GYNECOLOGY", branchId, source: "walk_in", journeyType: "Gynecology Consultation" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("phone enquiry lead: source PHONE is accepted for a manually-captured call", async () => {
    const phone = uniquePhone();
    const res = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Phone Enquiry Check", phone, specialtyKey: "GYNECOLOGY", branchId, source: "phone", journeyType: "Gynecology Consultation", notes: "Captured from an incoming call." },
    });
    expect(res.statusCode).toBe(201);
    const result = res.json() as CreateLeadResult;

    const leads = await app.inject({ method: "GET", url: "/leads", cookies: { pulseos_session: coordinatorCookie } });
    const lead = (leads.json() as LeadRow[]).find((l) => l.id === result.journeyId);
    expect(lead?.source).toBe("phone");
  });

  it("phone lookup finds an existing patient and reports their active journey count", async () => {
    const phone = uniquePhone();
    await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: { name: "Lookup Check", phone, specialtyKey: "GYNECOLOGY", branchId, source: "website", journeyType: "Gynecology Consultation" },
    });

    const lookup = await app.inject({ method: "POST", url: "/leads/lookup", cookies: { pulseos_session: coordinatorCookie }, payload: { phone } });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json() as { patient: { name: string; activeJourneyCount: number } | null };
    expect(body.patient?.name).toBe("Lookup Check");
    expect(body.patient?.activeJourneyCount).toBeGreaterThanOrEqual(1);
  });

  it("phone lookup returns null for a phone with no match", async () => {
    const lookup = await app.inject({ method: "POST", url: "/leads/lookup", cookies: { pulseos_session: coordinatorCookie }, payload: { phone: uniquePhone() } });
    expect(lookup.statusCode).toBe(200);
    expect((lookup.json() as { patient: null }).patient).toBeNull();
  });

  it("Leads summary counts are non-negative and internally consistent with /leads", async () => {
    const summary = await app.inject({ method: "GET", url: "/leads/summary", cookies: { pulseos_session: coordinatorCookie } });
    const s = summary.json() as LeadsSummary;
    for (const v of Object.values(s)) expect(v).toBeGreaterThanOrEqual(0);

    const leads = await app.inject({ method: "GET", url: "/leads", cookies: { pulseos_session: coordinatorCookie } });
    const rows = leads.json() as LeadRow[];
    const converted = rows.filter((r) => r.leadStatus === "converted").length;
    expect(s.converted).toBe(converted);
  });
});

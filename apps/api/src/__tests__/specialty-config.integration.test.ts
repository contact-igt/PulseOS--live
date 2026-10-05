import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { customFieldDefinitions, customFieldValues } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { CreateLeadResult, CustomFieldDefinitionVm, Patient360, SpecialtyDetailVm, SpecialtyTemplateVm } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

function uniquePhone(): string {
  return `9${Math.floor(100000000 + Math.random() * 899999999)}`;
}

describe.skipIf(!DEMO_PASSWORD)("specialty configuration (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let coordinatorCookie: string;
  let branchId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    coordinatorCookie = await loginAs(app, "gyn.coordinator@pulseos.local");
    const lookups = await app.inject({ method: "GET", url: "/lookups", cookies: { pulseos_session: adminCookie } });
    branchId = (lookups.json() as { branches: { id: string }[] }).branches[0].id;
  });

  afterAll(async () => {
    // The fields this suite adds (fixed keys) are removed with their values, so the suite is repeatable.
    const created = await db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(inArray(customFieldDefinitions.key, ["allergy_notes", "referral_source", "insurance_provider", "referred_by"]));
    const ids = created.map((c) => c.id);
    if (ids.length) {
      await db.delete(customFieldValues).where(inArray(customFieldValues.fieldDefinitionId, ids));
      await db.delete(customFieldDefinitions).where(and(inArray(customFieldDefinitions.id, ids)));
    }
    await app.close();
    await queryClient.end();
  });

  it("any authenticated role can read the enabled specialty list (needed to render Add Lead)", async () => {
    const res = await app.inject({ method: "GET", url: "/specialties", cookies: { pulseos_session: coordinatorCookie } });
    expect(res.statusCode).toBe(200);
    const specialties = res.json() as SpecialtyTemplateVm[];
    expect(specialties.length).toBeGreaterThan(0);
    expect(specialties.every((s) => s.enabled)).toBe(true);
    expect(specialties.map((s) => s.key)).toContain("GYNECOLOGY");
  });

  it("a role without MANAGE_SPECIALTIES (Coordinator) cannot read specialty detail or mutate config", async () => {
    const detail = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: coordinatorCookie } });
    expect(detail.statusCode).toBe(403);
    expect(detail.json().requiredPermission).toBe("MANAGE_SPECIALTIES");

    const patch = await app.inject({ method: "PATCH", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: coordinatorCookie }, payload: { enabled: false } });
    expect(patch.statusCode).toBe(403);
  });

  it("Hospital Admin can view a specialty's active custom fields, in sortOrder", async () => {
    const res = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const detail = res.json() as SpecialtyDetailVm;
    expect(detail.displayName).toBe("Gynecology / Maternity");
    expect(detail.fields.length).toBeGreaterThan(0);
    expect(detail.fields.map((f) => f.key)).toContain("edd");
    for (let i = 1; i < detail.fields.length; i++) {
      expect(detail.fields[i].sortOrder).toBeGreaterThanOrEqual(detail.fields[i - 1].sortOrder);
    }
  });

  it("Hospital Admin can disable a specialty and it drops out of the enabled list", async () => {
    const before = await app.inject({ method: "GET", url: "/specialties", cookies: { pulseos_session: adminCookie } });
    expect((before.json() as SpecialtyTemplateVm[]).map((s) => s.key)).toContain("FERTILITY");

    const patch = await app.inject({ method: "PATCH", url: "/specialties/FERTILITY", cookies: { pulseos_session: adminCookie }, payload: { enabled: false } });
    expect(patch.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/specialties", cookies: { pulseos_session: adminCookie } });
    expect((after.json() as SpecialtyTemplateVm[]).map((s) => s.key)).not.toContain("FERTILITY");

    // Re-enable so it doesn't leak into other tests / demo state.
    await app.inject({ method: "PATCH", url: "/specialties/FERTILITY", cookies: { pulseos_session: adminCookie }, payload: { enabled: true } });
    const restored = await app.inject({ method: "GET", url: "/specialties", cookies: { pulseos_session: adminCookie } });
    expect((restored.json() as SpecialtyTemplateVm[]).map((s) => s.key)).toContain("FERTILITY");
  });

  it("Hospital Admin can add a custom field to a specialty and it appears via the Add-Lead-facing endpoint", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/specialties/FERTILITY/fields",
      cookies: { pulseos_session: adminCookie },
      payload: { key: "allergy_notes", label: "Allergy notes", fieldType: "TEXT" },
    });
    expect(create.statusCode).toBe(201);
    const field = create.json() as CustomFieldDefinitionVm;
    expect(field.archived).toBe(false);

    const activeFields = await app.inject({ method: "GET", url: "/specialties/FERTILITY/fields", cookies: { pulseos_session: coordinatorCookie } });
    expect((activeFields.json() as CustomFieldDefinitionVm[]).map((f) => f.key)).toContain("allergy_notes");

    const archive = await app.inject({ method: "PATCH", url: `/specialties/fields/${field.id}`, cookies: { pulseos_session: adminCookie }, payload: { archived: true } });
    expect(archive.statusCode).toBe(200);

    const afterArchive = await app.inject({ method: "GET", url: "/specialties/FERTILITY/fields", cookies: { pulseos_session: coordinatorCookie } });
    expect((afterArchive.json() as CustomFieldDefinitionVm[]).map((f) => f.key)).not.toContain("allergy_notes");
  });

  it("Hospital Admin can edit a specialty's display label and default Journey type — historical value restored after", async () => {
    const before = await app.inject({ method: "GET", url: "/specialties/FERTILITY", cookies: { pulseos_session: adminCookie } });
    const original = before.json() as SpecialtyDetailVm;

    try {
      const patch = await app.inject({
        method: "PATCH",
        url: "/specialties/FERTILITY",
        cookies: { pulseos_session: adminCookie },
        payload: { displayName: "Fertility & IVF Care", defaultJourneyType: "Child Wellness" },
      });
      expect(patch.statusCode).toBe(200);

      const after = await app.inject({ method: "GET", url: "/specialties/FERTILITY", cookies: { pulseos_session: adminCookie } });
      const updated = after.json() as SpecialtyDetailVm;
      expect(updated.displayName).toBe("Fertility & IVF Care");
      expect(updated.defaultJourneyType).toBe("Child Wellness");
    } finally {
      await app.inject({
        method: "PATCH",
        url: "/specialties/FERTILITY",
        cookies: { pulseos_session: adminCookie },
        payload: { displayName: original.displayName, defaultJourneyType: original.defaultJourneyType },
      });
    }
  });

  it("Hospital Admin can reorder a specialty's fields by swapping sortOrder, and the new order persists", async () => {
    const before = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: adminCookie } });
    const fields = (before.json() as SpecialtyDetailVm).fields;
    expect(fields.length).toBeGreaterThanOrEqual(2);
    const [first, second] = fields;

    try {
      await app.inject({ method: "PATCH", url: `/specialties/fields/${first.id}`, cookies: { pulseos_session: adminCookie }, payload: { sortOrder: second.sortOrder } });
      await app.inject({ method: "PATCH", url: `/specialties/fields/${second.id}`, cookies: { pulseos_session: adminCookie }, payload: { sortOrder: first.sortOrder } });

      const after = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: adminCookie } });
      const reordered = (after.json() as SpecialtyDetailVm).fields;
      expect(reordered[0].id).toBe(second.id);
      expect(reordered[1].id).toBe(first.id);
    } finally {
      await app.inject({ method: "PATCH", url: `/specialties/fields/${first.id}`, cookies: { pulseos_session: adminCookie }, payload: { sortOrder: first.sortOrder } });
      await app.inject({ method: "PATCH", url: `/specialties/fields/${second.id}`, cookies: { pulseos_session: adminCookie }, payload: { sortOrder: second.sortOrder } });
    }
  });

  it("a SELECT field's options can be created and later edited, and both persist", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/specialties/GYNECOLOGY/fields",
      cookies: { pulseos_session: adminCookie },
      payload: { key: "referral_source", label: "Referral source", fieldType: "SELECT", options: ["Doctor", "Family"] },
    });
    expect(create.statusCode).toBe(201);
    const field = create.json() as CustomFieldDefinitionVm;
    expect(field.options).toEqual(["Doctor", "Family"]);

    const edit = await app.inject({
      method: "PATCH",
      url: `/specialties/fields/${field.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { options: ["Doctor", "Family", "Online ad"] },
    });
    expect(edit.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY", cookies: { pulseos_session: adminCookie } });
    const persisted = (detail.json() as SpecialtyDetailVm).fields.find((f) => f.id === field.id);
    expect(persisted?.options).toEqual(["Doctor", "Family", "Online ad"]);

    await app.inject({ method: "PATCH", url: `/specialties/fields/${field.id}`, cookies: { pulseos_session: adminCookie }, payload: { archived: true } });
  });

  it("archiving a field preserves values already recorded against it on existing journeys — no cascade delete", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/specialties/GYNECOLOGY/fields",
      cookies: { pulseos_session: adminCookie },
      payload: { key: "insurance_provider", label: "Insurance provider", fieldType: "TEXT" },
    });
    const field = create.json() as CustomFieldDefinitionVm;

    const lead = await app.inject({
      method: "POST",
      url: "/leads",
      cookies: { pulseos_session: coordinatorCookie },
      payload: {
        name: "Archive History Check",
        phone: uniquePhone(),
        specialtyKey: "GYNECOLOGY",
        branchId,
        source: "website",
        journeyType: "Gynecology Consultation",
        customFieldValues: { insurance_provider: "Star Health" },
      },
    });
    const { journeyId, patientId } = lead.json() as CreateLeadResult;

    // Before archiving: the value is visible on Patient 360 (this endpoint
    // previously never surfaced custom field values at all — see
    // patient.service.ts::getPatient360).
    const before360 = await app.inject({ method: "GET", url: `/patients/${patientId}/360`, cookies: { pulseos_session: adminCookie } });
    const beforeJourney = (before360.json() as Patient360).journeys.find((j) => j.id === journeyId);
    expect(beforeJourney?.customFields).toContainEqual(expect.objectContaining({ label: "Insurance provider", value: "Star Health" }));

    await app.inject({ method: "PATCH", url: `/specialties/fields/${field.id}`, cookies: { pulseos_session: adminCookie }, payload: { archived: true } });

    const [valueRow] = await db.select().from(customFieldValues).where(eq(customFieldValues.journeyId, journeyId));
    expect(valueRow).toBeDefined();
    expect(valueRow.value).toBe("Star Health");

    const activeFields = await app.inject({ method: "GET", url: "/specialties/GYNECOLOGY/fields", cookies: { pulseos_session: coordinatorCookie } });
    expect((activeFields.json() as CustomFieldDefinitionVm[]).map((f) => f.key)).not.toContain("insurance_provider");

    // After archiving: the historical value must still show on Patient 360
    // — archiving retires the field from new leads, it must never erase or
    // hide what was already recorded against an existing journey.
    const after360 = await app.inject({ method: "GET", url: `/patients/${patientId}/360`, cookies: { pulseos_session: adminCookie } });
    const afterJourney = (after360.json() as Patient360).journeys.find((j) => j.id === journeyId);
    expect(afterJourney?.customFields).toContainEqual(expect.objectContaining({ label: "Insurance provider", value: "Star Health" }));
  });

  it("a specialty key that does not exist for this tenant 404s rather than leaking another tenant's config", async () => {
    const res = await app.inject({ method: "GET", url: "/specialties/NOT_A_REAL_SPECIALTY", cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(404);
  });

  it("FLOW 5: enabling a field makes it appear for Add Lead, archiving it makes it disappear again", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/specialties/FERTILITY/fields",
      cookies: { pulseos_session: adminCookie },
      payload: { key: "referred_by", label: "Referred by", fieldType: "TEXT" },
    });
    const field = create.json() as CustomFieldDefinitionVm;

    const fields = await app.inject({ method: "GET", url: "/specialties/FERTILITY/fields", cookies: { pulseos_session: coordinatorCookie } });
    expect((fields.json() as CustomFieldDefinitionVm[]).some((f) => f.key === "referred_by")).toBe(true);

    await app.inject({ method: "PATCH", url: `/specialties/fields/${field.id}`, cookies: { pulseos_session: adminCookie }, payload: { archived: true } });
  });
});

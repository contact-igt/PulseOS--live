import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, like } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { customFieldDefinitions, customFieldValues } from "../db/schema.js";
import { purgePatientData } from "./helpers/purge.js";
import type { FastifyInstance } from "fastify";
import type { CrmFieldVm, CreateLeadResult, JourneyDetailVm, Patient360 } from "@pulseos/types";

// CRM field configuration: one field system (custom_field_definitions) extended with groups,
// placements, defaults, role visibility and an all-services scope. Archive hides a field from new
// entry but never from history.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const PREFIX = "t_crm_";

async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

describe.skipIf(!DEMO_PASSWORD)("CRM fields (integration)", () => {
  let app: FastifyInstance;
  let admin: string;
  let coordinator: string;
  let doctor: string;
  let gynAdmin: string;
  let branchId: string;
  const createdIds: string[] = [];
  const patientIds: string[] = [];

  const call = (cookie: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined, cookies: { pulseos_session: cookie } });
  async function createField(input: Record<string, unknown>, cookie = admin) {
    const res = await call(cookie, "POST", "/crm/fields", { specialtyKey: "CATARACT", ...input });
    if (res.statusCode === 201) createdIds.push((res.json() as CrmFieldVm).id);
    return res;
  }
  const forEntry = async (cookie: string, placement: string, specialtyKey: string) =>
    (await call(cookie, "GET", `/crm/fields/for?placement=${placement}&specialtyKey=${specialtyKey}`)).json() as CrmFieldVm[];
  async function addLead(values: Record<string, unknown>, specialtyKey = "CATARACT") {
    const res = await call(admin, "POST", "/leads", { name: "CRM Field Patient", phone: phone(), specialtyKey, branchId, source: "walk_in", journeyType: "Cataract", customFieldValues: values });
    if (res.statusCode === 201) patientIds.push((res.json() as CreateLeadResult).patientId);
    return res;
  }

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
    const stray = await db.select({ id: customFieldDefinitions.id }).from(customFieldDefinitions).where(like(customFieldDefinitions.key, `${PREFIX}%`));
    const ids = [...new Set([...createdIds, ...stray.map((s) => s.id)])];
    if (ids.length) {
      await db.delete(customFieldValues).where(inArray(customFieldValues.fieldDefinitionId, ids));
      await db.delete(customFieldDefinitions).where(inArray(customFieldDefinitions.id, ids));
    }
    await app.close();
    await queryClient.end();
  });

  it("only an admin may configure; any role may read the fields that apply to an entry form", async () => {
    expect((await createField({ key: `${PREFIX}perm`, label: "Perm", fieldType: "TEXT" }, coordinator)).statusCode).toBe(403);
    expect((await call(coordinator, "GET", "/crm/fields")).statusCode).toBe(403);
    expect((await call(coordinator, "GET", "/crm/fields/for?placement=add_lead&specialtyKey=CATARACT")).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/crm/fields" })).statusCode).toBe(401);
  });

  it("creates a field with sensible defaults, then edits label, group, placements, default and visibility", async () => {
    const res = await createField({ key: `${PREFIX}budget`, label: "Budget", fieldType: "NUMBER" });
    expect(res.statusCode).toBe(201);
    const f = res.json() as CrmFieldVm;
    expect(f).toMatchObject({ key: `${PREFIX}budget`, specialtyKey: "CATARACT", required: false, archived: false, groupKey: "enquiry_details", visibleTo: "everyone" });
    expect(f.placements).toEqual(["add_lead", "journey_detail", "patient_360"]);

    const patch = await call(admin, "PATCH", `/crm/fields/${f.id}`, { label: "Budget (₹)", groupKey: "qualification", placements: ["add_lead", "followup_outcome"], defaultValue: 50000, visibleTo: "front_office" });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ label: "Budget (₹)", groupKey: "qualification", placements: ["add_lead", "followup_outcome"], defaultValue: 50000, visibleTo: "front_office" });
  });

  it("rejects bad configuration: unknown type/group/placement, duplicate key, select without options", async () => {
    expect((await createField({ key: `${PREFIX}x1`, label: "X", fieldType: "RICH_TEXT" })).statusCode).toBe(400);
    expect((await createField({ key: `${PREFIX}x2`, label: "X", fieldType: "TEXT", groupKey: "made_up" })).statusCode).toBe(400);
    expect((await createField({ key: `${PREFIX}x3`, label: "X", fieldType: "TEXT", placements: ["lobby_tv"] })).statusCode).toBe(400);
    expect((await createField({ key: `${PREFIX}x4`, label: "X", fieldType: "SELECT" })).statusCode).toBe(400);
    expect((await createField({ key: `${PREFIX}x5`, label: "X", fieldType: "SELECT", options: [] })).statusCode).toBe(400);
    expect((await createField({ key: `${PREFIX}budget`, label: "Dup", fieldType: "TEXT" })).statusCode).toBe(409);
    expect((await createField({ key: "Not Valid Key!", label: "X", fieldType: "TEXT" })).statusCode).toBe(400);
  });

  it("supports every field type including long text, email and date/time", async () => {
    for (const [i, type] of (["TEXT", "LONG_TEXT", "NUMBER", "PHONE", "EMAIL", "DATE", "DATETIME", "BOOLEAN"] as const).entries()) {
      expect((await createField({ key: `${PREFIX}type_${i}`, label: type, fieldType: type })).statusCode).toBe(201);
    }
  });

  it("required fields are enforced at Add Lead; optional ones are not", async () => {
    await createField({ key: `${PREFIX}must`, label: "Must have", fieldType: "TEXT", required: true });
    await createField({ key: `${PREFIX}nice`, label: "Nice to have", fieldType: "TEXT", required: false });
    const missing = await addLead({ [`${PREFIX}nice`]: "x" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: "missing_required_fields" });
    expect(missing.json().fields).toContain(`${PREFIX}must`);
    expect((await addLead({ [`${PREFIX}must`]: "present" })).statusCode).toBe(201);
  });

  it("validates values by type, and select / multi-select values must be among the options", async () => {
    await createField({ key: `${PREFIX}pick`, label: "Pick", fieldType: "SELECT", options: ["A", "B"] });
    await createField({ key: `${PREFIX}multi`, label: "Multi", fieldType: "MULTI_SELECT", options: ["X", "Y", "Z"] });
    await createField({ key: `${PREFIX}num`, label: "Num", fieldType: "NUMBER" });
    await createField({ key: `${PREFIX}mail`, label: "Mail", fieldType: "EMAIL" });
    const invalid = async (values: Record<string, unknown>) => {
      const res = await addLead({ [`${PREFIX}must`]: "ok", ...values });
      expect(res.statusCode, JSON.stringify(values)).toBe(422);
      expect(res.json().error).toBe("invalid_field_values");
    };
    await invalid({ [`${PREFIX}pick`]: "C" });
    await invalid({ [`${PREFIX}multi`]: ["X", "Q"] });
    await invalid({ [`${PREFIX}multi`]: "X" });
    await invalid({ [`${PREFIX}num`]: "twelve" });
    await invalid({ [`${PREFIX}mail`]: "not-an-email" });
    const ok = await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}pick`]: "B", [`${PREFIX}multi`]: ["X", "Z"], [`${PREFIX}num`]: 12, [`${PREFIX}mail`]: "a@b.co" });
    expect(ok.statusCode).toBe(201);
  });

  it("reorders fields inside a group in one call", async () => {
    const mk = async (k: string) => ((await createField({ key: `${PREFIX}ord_${k}`, label: k, fieldType: "TEXT", groupKey: "service_details" })).json() as CrmFieldVm).id;
    const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];
    const res = await call(admin, "POST", "/crm/fields/reorder", { groupKey: "service_details", specialtyKey: "CATARACT", orderedIds: [c, a, b] });
    expect(res.statusCode).toBe(200);
    const list = (await call(admin, "GET", "/crm/fields?specialtyKey=CATARACT")).json() as CrmFieldVm[];
    const order = list.filter((f) => [a, b, c].includes(f.id)).sort((x, y) => x.sortOrder - y.sortOrder).map((f) => f.id);
    expect(order).toEqual([c, a, b]);
    expect((await call(admin, "POST", "/crm/fields/reorder", { groupKey: "service_details", specialtyKey: "CATARACT", orderedIds: [c, "00000000-0000-4000-8000-000000000000"] })).statusCode).toBe(400);
  });

  it("scopes a field to one service or to all services", async () => {
    await createField({ key: `${PREFIX}only_cat`, label: "Only cataract", fieldType: "TEXT" });
    await createField({ key: `${PREFIX}everyone_svc`, label: "All services", fieldType: "TEXT", specialtyKey: "*" });
    const cataract = (await forEntry(coordinator, "add_lead", "CATARACT")).map((f) => f.key);
    const lasik = (await forEntry(coordinator, "add_lead", "LASER_VISION_CORRECTION")).map((f) => f.key);
    expect(cataract).toContain(`${PREFIX}only_cat`);
    expect(lasik).not.toContain(`${PREFIX}only_cat`);
    expect(cataract).toContain(`${PREFIX}everyone_svc`);
    expect(lasik).toContain(`${PREFIX}everyone_svc`);
    // An all-services value can be saved on any service's Journey.
    const lead = await addLead({ [`${PREFIX}must`]: undefined, [`${PREFIX}everyone_svc`]: "set" }, "LASER_VISION_CORRECTION");
    expect(lead.statusCode).toBe(201);
  });

  it("placements decide where a field appears; defaults are returned for the form", async () => {
    await createField({ key: `${PREFIX}place`, label: "Placed", fieldType: "TEXT", placements: ["followup_outcome", "appointment"], defaultValue: "hello" });
    expect((await forEntry(coordinator, "add_lead", "CATARACT")).map((f) => f.key)).not.toContain(`${PREFIX}place`);
    const followup = (await forEntry(coordinator, "followup_outcome", "CATARACT")).find((f) => f.key === `${PREFIX}place`);
    expect(followup?.defaultValue).toBe("hello");
    expect((await forEntry(coordinator, "appointment", "CATARACT")).map((f) => f.key)).toContain(`${PREFIX}place`);
    expect((await call(coordinator, "GET", "/crm/fields/for?placement=lobby_tv&specialtyKey=CATARACT")).statusCode).toBe(400);
  });

  it("entry fields can be asked for by Journey (its service decides the scope); another hospital's Journey is not found", async () => {
    await createField({ key: `${PREFIX}by_journey`, label: "By journey", fieldType: "TEXT", placements: ["followup_outcome"] });
    const lead = (await addLead({ [`${PREFIX}must`]: "ok" })).json() as CreateLeadResult;
    const viaJourney = (await call(coordinator, "GET", `/crm/fields/for?placement=followup_outcome&journeyId=${lead.journeyId}`)).json() as CrmFieldVm[];
    expect(viaJourney.map((f) => f.key)).toContain(`${PREFIX}by_journey`);
    expect((await call(gynAdmin, "GET", `/crm/fields/for?placement=followup_outcome&journeyId=${lead.journeyId}`)).statusCode).toBe(404);
    expect((await call(coordinator, "GET", "/crm/fields/for?placement=followup_outcome")).statusCode).toBe(400);
    expect((await call(coordinator, "GET", "/crm/fields/for?placement=followup_outcome&journeyId=not-a-uuid")).statusCode).toBe(400);
  });

  it("role visibility is enforced on the server for definitions and for values", async () => {
    const clinical = (await createField({ key: `${PREFIX}clin`, label: "Clinical note", fieldType: "TEXT", visibleTo: "clinical" })).json() as CrmFieldVm;
    const frontOffice = (await createField({ key: `${PREFIX}fo`, label: "Front office note", fieldType: "TEXT", visibleTo: "front_office" })).json() as CrmFieldVm;
    expect(clinical.id && frontOffice.id).toBeTruthy();
    const keysFor = async (cookie: string) => (await forEntry(cookie, "add_lead", "CATARACT")).map((f) => f.key);
    expect(await keysFor(coordinator)).toContain(`${PREFIX}fo`);
    expect(await keysFor(coordinator)).not.toContain(`${PREFIX}clin`);
    expect(await keysFor(doctor)).toContain(`${PREFIX}clin`);
    expect(await keysFor(doctor)).not.toContain(`${PREFIX}fo`);

    const lead = (await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}clin`]: "secret-clinical", [`${PREFIX}fo`]: "front-office-only" })).json() as CreateLeadResult;
    const journeyFor = async (cookie: string) => ((await call(cookie, "GET", `/journeys/${lead.journeyId}`)).json() as JourneyDetailVm).customFields.map((f) => f.label);
    expect(await journeyFor(coordinator)).toContain("Front office note");
    expect(await journeyFor(coordinator)).not.toContain("Clinical note");
    expect(await journeyFor(doctor)).toContain("Clinical note");
    expect(await journeyFor(doctor)).not.toContain("Front office note");
    const p360 = async (cookie: string) => ((await call(cookie, "GET", `/patients/${lead.patientId}/360`)).json() as Patient360).journeys.flatMap((j) => j.customFields.map((f) => f.label));
    expect(await p360(coordinator)).not.toContain("Clinical note");
    expect(await p360(doctor)).toContain("Clinical note");
  });

  it("archive hides a field from new entry but keeps its history on Journey Detail and Patient 360", async () => {
    const field = (await createField({ key: `${PREFIX}arch`, label: "Archive me", fieldType: "TEXT" })).json() as CrmFieldVm;
    const lead = (await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}arch`]: "historic value" })).json() as CreateLeadResult;

    const archived = await call(admin, "PATCH", `/crm/fields/${field.id}`, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect((await forEntry(coordinator, "add_lead", "CATARACT")).map((f) => f.key)).not.toContain(`${PREFIX}arch`);
    // A new entry cannot write to it: the value is ignored, the lead is still created.
    const fresh = (await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}arch`]: "new value" })).json() as CreateLeadResult;
    expect(((await call(coordinator, "GET", `/journeys/${fresh.journeyId}`)).json() as JourneyDetailVm).customFields.map((f) => f.label)).not.toContain("Archive me");
    const detail = (await call(coordinator, "GET", `/journeys/${lead.journeyId}`)).json() as JourneyDetailVm;
    expect(detail.customFields.find((f) => f.label === "Archive me")?.value).toBe("historic value");
    const p360 = (await call(coordinator, "GET", `/patients/${lead.patientId}/360`)).json() as Patient360;
    expect(p360.journeys.flatMap((j) => j.customFields).find((f) => f.label === "Archive me")?.value).toBe("historic value");
    // ...and the admin can still see and restore it.
    const list = (await call(admin, "GET", "/crm/fields?includeArchived=true&specialtyKey=CATARACT")).json() as CrmFieldVm[];
    expect(list.find((f) => f.id === field.id)?.archived).toBe(true);
    expect((await call(admin, "PATCH", `/crm/fields/${field.id}`, { archived: false })).statusCode).toBe(200);
    expect((await forEntry(coordinator, "add_lead", "CATARACT")).map((f) => f.key)).toContain(`${PREFIX}arch`);
    // There is no destructive delete.
    expect((await app.inject({ method: "DELETE", url: `/crm/fields/${field.id}`, cookies: { pulseos_session: admin } })).statusCode).toBe(404);
  });

  it("shows dates and date-times as people read them, in the hospital timezone", async () => {
    await createField({ key: `${PREFIX}cb_day`, label: "Callback day", fieldType: "DATE" });
    await createField({ key: `${PREFIX}cb_at`, label: "Callback at", fieldType: "DATETIME" });
    const lead = (await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}cb_day`]: "2026-10-02", [`${PREFIX}cb_at`]: "2026-10-02T04:30:00.000Z" })).json() as CreateLeadResult;
    const detail = (await call(coordinator, "GET", `/journeys/${lead.journeyId}`)).json() as JourneyDetailVm;
    expect(detail.customFields.find((f) => f.label === "Callback day")?.value).toBe("2 Oct 2026");
    // 04:30 UTC is 10:00 in Asia/Kolkata — and it is the same on Patient 360.
    expect(detail.customFields.find((f) => f.label === "Callback at")?.value).toBe("2 Oct 2026, 10:00 am");
    const p360 = (await call(coordinator, "GET", `/patients/${lead.patientId}/360`)).json() as Patient360;
    expect(p360.journeys.flatMap((j) => j.customFields).find((f) => f.label === "Callback at")?.value).toBe("2 Oct 2026, 10:00 am");
  });

  it("key and type are immutable once a value exists", async () => {
    const field = (await createField({ key: `${PREFIX}lock`, label: "Lock", fieldType: "TEXT" })).json() as CrmFieldVm;
    expect((await call(admin, "PATCH", `/crm/fields/${field.id}`, { fieldType: "NUMBER" })).statusCode).toBe(200); // no values yet: allowed
    await addLead({ [`${PREFIX}must`]: "ok", [`${PREFIX}lock`]: 5 });
    const res = await call(admin, "PATCH", `/crm/fields/${field.id}`, { fieldType: "TEXT" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("field_has_values");
    expect((await call(admin, "PATCH", `/crm/fields/${field.id}`, { key: `${PREFIX}renamed` })).statusCode).toBe(400);
  });

  it("is tenant-isolated: another hospital cannot list, read, edit or reorder these fields", async () => {
    const field = (await createField({ key: `${PREFIX}iso`, label: "Isolated", fieldType: "TEXT" })).json() as CrmFieldVm;
    const gynList = (await call(gynAdmin, "GET", "/crm/fields?includeArchived=true")).json() as CrmFieldVm[];
    expect(gynList.map((f) => f.id)).not.toContain(field.id);
    expect((await call(gynAdmin, "PATCH", `/crm/fields/${field.id}`, { label: "Hacked" })).statusCode).toBe(404);
    expect((await call(gynAdmin, "POST", "/crm/fields/reorder", { groupKey: "enquiry_details", specialtyKey: "CATARACT", orderedIds: [field.id] })).statusCode).toBe(400);
    // A tenantId smuggled into the body is ignored: the field lands in the caller's own tenant.
    const smuggled = await call(gynAdmin, "POST", "/crm/fields", { specialtyKey: "GYNECOLOGY", key: `${PREFIX}smuggle`, label: "S", fieldType: "TEXT", tenantId: "00000000-0000-4000-8000-000000000000" });
    if (smuggled.statusCode === 201) createdIds.push((smuggled.json() as CrmFieldVm).id);
    expect(smuggled.statusCode).toBe(201);
    expect((await call(admin, "GET", "/crm/fields?includeArchived=true")).json().map((f: CrmFieldVm) => f.key)).not.toContain(`${PREFIX}smuggle`);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { evaluateFieldRules, type CrmFieldVm, type FieldRule, type LeadsWorkspace, type Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { activityLog, customFieldDefinitions, customFieldValues, timelineEvents } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const PW = process.env.DEMO_PASSWORD;
const rule = (r: FieldRule) => r;

describe("field rules (pure, shared by server and form)", () => {
  const f = (key: string, required: boolean, rules: FieldRule[] = []) => ({ key, required, rules });
  it("an outcome rule shows and requires fields only for that outcome", () => {
    const fields = [f("appointment_date", false, [rule({ when: { outcome: ["appointment_booked"] }, then: "show" }), rule({ when: { outcome: ["appointment_booked"] }, then: "require" })])];
    expect(evaluateFieldRules(fields, { outcomeKey: "needs_callback", values: {} }).appointment_date).toEqual({ visible: false, required: false });
    expect(evaluateFieldRules(fields, { outcomeKey: "appointment_booked", values: {} }).appointment_date).toEqual({ visible: true, required: true });
    expect(evaluateFieldRules(fields, { outcomeKey: null, values: {} }).appointment_date.visible).toBe(false);
  });

  it("a child field follows its parent's answer; a hidden parent hides its children even with a stale answer", () => {
    const fields = [
      f("enquiry", false, []),
      f("t_laterality", true, [rule({ when: { field: "enquiry", equals: ["Cataract"] }, then: "show" })]),
      f("eye_detail", false, [rule({ when: { field: "t_laterality", equals: ["Right"] }, then: "show" })]),
    ];
    expect(evaluateFieldRules(fields, { values: { enquiry: "LASIK" } }).t_laterality).toEqual({ visible: false, required: false }); // a static required field that is hidden is not required
    const on = evaluateFieldRules(fields, { values: { enquiry: "Cataract", t_laterality: "Right" } });
    expect(on.t_laterality).toEqual({ visible: true, required: true });
    expect(on.eye_detail.visible).toBe(true);
    const stale = evaluateFieldRules(fields, { values: { enquiry: "LASIK", t_laterality: "Right" } });
    expect(stale.eye_detail.visible).toBe(false); // parent hidden → child hidden
  });

  it("multi-select answers match when any chosen option is listed; no rules means always visible", () => {
    const fields = [f("c", false), f("d", false, [rule({ when: { field: "c", equals: ["B"] }, then: "show" })])];
    expect(evaluateFieldRules(fields, { values: { c: ["A", "B"] } }).d.visible).toBe(true);
    expect(evaluateFieldRules(fields, { values: { c: ["A"] } }).d.visible).toBe(false);
    expect(evaluateFieldRules(fields, { values: {} }).c).toEqual({ visible: true, required: false });
  });
});

describe.skipIf(!PW)("CRM field behaviour (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9198${String(41000000 + ++n * 37).padStart(8, "0")}`;
  const mkField = (body: object, tt = t) => call(tt, "HOSPITAL_ADMIN", "POST", "/crm/fields", { specialtyKey: "CATARACT", fieldType: "SELECT", options: ["Yes", "No"], placements: ["add_lead", "followup_outcome", "journey_detail"], ...body });
  const lead = (tt: TestTenant, customFieldValues: object, extra: object = {}) =>
    call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Beh Patient", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues, ...extra });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", PW!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", PW!);
    for (const tt of [t, other]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
  });
  afterAll(async () => {
    for (const tt of [t, other]) {
      await db.delete(customFieldValues).where(eq(customFieldValues.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("rules are validated: unknown outcome / field / option, self-dependency, cycles, and too many are refused", async () => {
    expect((await mkField({ key: "t_diabetes", label: "Diabetes" })).statusCode).toBe(201);
    expect((await mkField({ key: "bad_outcome", label: "X", fieldType: "TEXT", rules: [{ when: { outcome: ["nope"] }, then: "show" }] })).json().error).toBe("rule_unknown_outcome");
    expect((await mkField({ key: "bad_field", label: "X", fieldType: "TEXT", rules: [{ when: { field: "ghost", equals: ["Yes"] }, then: "show" }] })).json().error).toBe("rule_unknown_field");
    expect((await mkField({ key: "bad_option", label: "X", fieldType: "TEXT", rules: [{ when: { field: "t_diabetes", equals: ["Maybe"] }, then: "show" }] })).json().error).toBe("rule_unknown_option");
    expect((await mkField({ key: "self_ref", label: "X", fieldType: "TEXT", rules: [{ when: { field: "self_ref", equals: ["Yes"] }, then: "show" }] })).json().error).toBe("rule_unknown_field");
    expect((await mkField({ key: "many", label: "X", fieldType: "TEXT", rules: Array.from({ length: 6 }, () => ({ when: { outcome: ["interested"] }, then: "show" })) })).statusCode).toBe(400);
    // Free-form conditions are not a thing: an expression is just an invalid rule.
    expect((await mkField({ key: "script", label: "X", fieldType: "TEXT", rules: [{ when: { expr: "1==1" }, then: "show" }] })).statusCode).toBe(400);
    // A cycle: a shows when b = Yes, then b may not show when a = Yes.
    expect((await mkField({ key: "cyc_a", label: "A", options: ["Yes", "No"] })).statusCode).toBe(201);
    expect((await mkField({ key: "cyc_b", label: "B", options: ["Yes", "No"], rules: [{ when: { field: "cyc_a", equals: ["Yes"] }, then: "show" }] })).statusCode).toBe(201);
    const a = (await call(t, "HOSPITAL_ADMIN", "GET", "/crm/fields?specialtyKey=CATARACT")).json() as CrmFieldVm[];
    const patchA = await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${a.find((x) => x.key === "cyc_a")!.id}`, { rules: [{ when: { field: "cyc_b", equals: ["Yes"] }, then: "show" }] });
    expect(patchA.json().error).toBe("rule_cycle");
  });

  it("conditional + nested fields on Add Lead: a child appears and is required only for its parent's answer; hidden answers are ignored", async () => {
    expect((await mkField({ key: "t_primary", label: "Primary enquiry", options: ["Cataract", "LASIK"] })).statusCode).toBe(201);
    expect((await mkField({ key: "t_laterality", label: "Laterality", options: ["Left", "Right", "Both"], required: true, rules: [{ when: { field: "t_primary", equals: ["Cataract"] }, then: "show" }] })).statusCode).toBe(201);
    // LASIK: t_laterality is hidden, so its (static) requirement does not apply and a stray answer is not stored.
    const lasik = await lead(t, { t_primary: "LASIK", t_laterality: "Left" });
    expect(lasik.statusCode).toBe(201);
    const rows = await db.select().from(customFieldValues).where(eq(customFieldValues.journeyId, lasik.json().journeyId));
    expect(rows.map((r) => r.value)).toEqual(["LASIK"]);
    // Cataract: t_laterality is shown and required.
    const missing = await lead(t, { t_primary: "Cataract" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toMatchObject({ error: "missing_required_fields", fields: ["t_laterality"] });
    expect((await lead(t, { t_primary: "Cataract", t_laterality: "Right" })).statusCode).toBe(201);
  });

  it("outcome-conditional fields: required by one outcome only, on the follow-up outcome form", async () => {
    expect((await mkField({ key: "t_callback_reason", label: "Callback reason", fieldType: "TEXT", options: undefined, placements: ["followup_outcome"], rules: [{ when: { outcome: ["needs_callback"] }, then: "show" }, { when: { outcome: ["needs_callback"] }, then: "require" }] })).statusCode).toBe(201);
    const { journeyId } = (await lead(t, { t_primary: "LASIK" })).json() as { journeyId: string };
    const follow = new Date(Date.now() + 86_400_000).toISOString();
    const needs = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "needs_callback", followUpAt: follow, fieldValues: {} });
    expect(needs.statusCode).toBe(422);
    expect(needs.json()).toMatchObject({ error: "missing_required_fields", fields: ["t_callback_reason"] });
    const ok = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "needs_callback", followUpAt: follow, fieldValues: { t_callback_reason: "Wants to ask the family" } });
    expect(ok.statusCode).toBe(201);
    // Another outcome: the field is hidden, nothing is required and a stray answer is ignored.
    const interested = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "interested", fieldValues: { t_callback_reason: "ignored" } });
    expect(interested.statusCode).toBe(201);
    // History stays historical: the Timeline line for the first interaction kept what was recorded then.
    const lines = await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, journeyId), eq(timelineEvents.eventType, "outcome_logged")));
    const withFields = lines.filter((l) => (l.metadata as { fields?: unknown[] } | null)?.fields?.length);
    expect(withFields).toHaveLength(1);
    expect((withFields[0]!.metadata as { fields: { key: string; value: string }[] }).fields[0]).toMatchObject({ key: "t_callback_reason", value: "Wants to ask the family" });
  });

  it("read-only: set once at intake, then refused when someone tries to change it", async () => {
    expect((await mkField({ key: "t_referral_code", label: "Referral code", fieldType: "TEXT", options: undefined, readOnly: true, placements: ["add_lead", "followup_outcome"] })).statusCode).toBe(201);
    const { journeyId } = (await lead(t, { t_primary: "LASIK", t_referral_code: "REF-1" })).json() as { journeyId: string };
    const change = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "interested", fieldValues: { t_referral_code: "REF-2" } });
    expect(change.statusCode).toBe(422);
    expect(change.json()).toMatchObject({ error: "field_read_only", fields: ["t_referral_code"] });
    expect((await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/interactions`, { outcomeKey: "interested", fieldValues: { t_referral_code: "REF-1" } })).statusCode).toBe(201); // same value: not a change
  });

  it("carry-forward: only fields marked so are offered again, at their current value (never outcome, dates or the rest)", async () => {
    expect((await mkField({ key: "t_preferred_slot", label: "Preferred time", options: ["Morning", "Evening"], carryForward: true, placements: ["add_lead", "followup_outcome"] })).statusCode).toBe(201);
    expect((await mkField({ key: "t_temp_note", label: "Temporary note", fieldType: "TEXT", options: undefined, placements: ["add_lead", "followup_outcome"] })).statusCode).toBe(201);
    const { journeyId } = (await lead(t, { t_primary: "LASIK", t_preferred_slot: "Evening", t_temp_note: "call after lunch" })).json() as { journeyId: string };
    const prefill = (await call(t, "FRONT_DESK", "GET", `/journeys/${journeyId}/field-prefill?placement=followup_outcome`)).json();
    expect(prefill).toEqual({ t_preferred_slot: "Evening" });
    expect((await call(other, "FRONT_DESK", "GET", `/journeys/${journeyId}/field-prefill?placement=followup_outcome`)).statusCode).toBe(404); // another hospital's journey
    // A carry-forward field must live on a form that asks for it again.
    expect((await mkField({ key: "bad_cf", label: "X", fieldType: "TEXT", options: undefined, carryForward: true, placements: ["patient_360"] })).json().error).toBe("carry_forward_needs_entry_form");
  });

  it("filterable: Leads offers the field and filters by its answer; non-filterable fields are not exposed", async () => {
    expect((await mkField({ key: "t_smoker", label: "Smoker", filterable: true })).statusCode).toBe(201);
    const yes = (await lead(t, { t_primary: "LASIK", t_smoker: "Yes" })).json().journeyId as string;
    const no = (await lead(t, { t_primary: "LASIK", t_smoker: "No" })).json().journeyId as string;
    const all = (await call(t, "HOSPITAL_ADMIN", "GET", "/leads/workspace")).json() as LeadsWorkspace;
    expect(all.options.filterableFields).toEqual([{ key: "t_smoker", label: "Smoker", options: ["Yes", "No"] }]);
    const onlyYes = (await call(t, "HOSPITAL_ADMIN", "GET", "/leads/workspace?fieldKey=t_smoker&fieldValue=Yes")).json() as LeadsWorkspace;
    const ids = onlyYes.rows.map((r) => r.id);
    expect(ids).toContain(yes);
    expect(ids).not.toContain(no);
    // A field that is not marked filterable cannot be used to filter (the parameter is ignored, nothing leaks).
    const ignored = (await call(t, "HOSPITAL_ADMIN", "GET", "/leads/workspace?fieldKey=t_diabetes&fieldValue=Yes")).json() as LeadsWorkspace;
    expect(ignored.rows.length).toBe(all.rows.length);
    // Tenant isolation: the other hospital sees neither the field nor the journeys.
    const theirs = (await call(other, "HOSPITAL_ADMIN", "GET", "/leads/workspace?fieldKey=t_smoker&fieldValue=Yes")).json() as LeadsWorkspace;
    expect(theirs.options.filterableFields).toEqual([]);
    expect(theirs.rows).toHaveLength(0);
  });

  it("review fixes: a clinical-only filterable field is not offered or usable by front desk; updates keep carry-forward and rules consistent", async () => {
    expect((await mkField({ key: "t_clin", label: "Clinical flag", filterable: true, visibleTo: "clinical" })).statusCode).toBe(201);
    const jr = await call(t, "HOSPITAL_ADMIN", "POST", "/leads", { phone: phone(), name: "Clin Patient", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: { t_primary: "LASIK", t_clin: "Yes" } });
    expect(jr.statusCode, jr.body).toBe(201);
    const j = jr.json().journeyId as string;
    const fdRes = await call(t, "FRONT_DESK", "GET", "/leads/workspace?fieldKey=t_clin&fieldValue=Yes");
    expect(fdRes.statusCode, fdRes.body).toBe(200);
    const fd = fdRes.json() as LeadsWorkspace;
    expect(fd.options.filterableFields.map((f) => f.key)).not.toContain("t_clin");
    expect(fd.rows.length).toBeGreaterThan(0); // filter ignored, not applied: nothing is inferable
    const doc = (await call(t, "HOSPITAL_ADMIN", "GET", "/leads/workspace?fieldKey=t_clin&fieldValue=Yes")).json() as LeadsWorkspace;
    expect(doc.rows.map((r) => r.id)).toContain(j);
    // Carry-forward needs an entry form, on update as on create.
    const detailOnly = (await mkField({ key: "t_detail_only", label: "Detail only", placements: ["journey_detail"] })).json().id as string;
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${detailOnly}`, { carryForward: true })).statusCode).toBe(422);
    // Removing an option a child rule matches on is refused.
    const parent = (await mkField({ key: "t_parent", label: "Parent", options: ["A", "B"] })).json().id as string;
    expect((await mkField({ key: "t_child", label: "Child", rules: [{ when: { field: "t_parent", equals: ["B"] }, then: "show" }] })).statusCode).toBe(201);
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${parent}`, { options: ["A"] })).statusCode).toBe(409);
    const clin = (await db.select({ id: customFieldDefinitions.id }).from(customFieldDefinitions).where(and(eq(customFieldDefinitions.tenantId, t.tenantId), eq(customFieldDefinitions.key, "t_clin"))))[0]!.id;
    await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${clin}`, { archived: true });
  });

  it("archiving keeps history and values; a field others depend on cannot be archived", async () => {
    const fields = (await call(t, "HOSPITAL_ADMIN", "GET", "/crm/fields?specialtyKey=CATARACT")).json() as CrmFieldVm[];
    const t_primary = fields.find((x) => x.key === "t_primary")!;
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${t_primary.id}`, { archived: true })).json().error).toBe("field_has_dependants"); // t_laterality depends on it
    const t_smoker = fields.find((x) => x.key === "t_smoker")!;
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/crm/fields/${t_smoker.id}`, { archived: true })).statusCode).toBe(200);
    expect((await db.select().from(customFieldValues).where(eq(customFieldValues.fieldDefinitionId, t_smoker.id))).length).toBeGreaterThan(0); // answers stay
    expect(((await call(t, "HOSPITAL_ADMIN", "GET", "/leads/workspace")).json() as LeadsWorkspace).options.filterableFields).toEqual([]); // no longer offered
  });

  it("field changes are in the activity log (who, which field), with no field values; staff cannot change fields", async () => {
    const log = (await call(t, "HOSPITAL_ADMIN", "GET", "/activity-log")).json() as { action: string; entityKey: string }[];
    expect(log.filter((e) => e.action === "crm_field.created").map((e) => e.entityKey)).toEqual(expect.arrayContaining(["t_primary", "t_laterality", "t_smoker"]));
    expect(log.some((e) => e.action === "crm_field.archived" && e.entityKey === "t_smoker")).toBe(true);
    expect((await call(t, "FRONT_DESK", "POST", "/crm/fields", { specialtyKey: "CATARACT", key: "nope_field", label: "N", fieldType: "TEXT" })).statusCode).toBe(403);
    expect((await db.select().from(activityLog).where(eq(activityLog.tenantId, other.tenantId))).filter((e) => e.action.startsWith("crm_field")).length).toBe(0);
  });
});

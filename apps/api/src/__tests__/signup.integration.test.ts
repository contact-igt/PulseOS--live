import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

// Public hospital sign-up: the server creates the tenant and its first Super Admin in one transaction; the client never
// supplies a tenant id; a double-submit makes ONE hospital; the new workspace is listed in Developer Access (dev only).

process.env.SIGNUP_MAX_PER_HOUR = "1000";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const DEV_LOGIN = process.env.ENABLE_DEV_LOGIN === "true";

const valid = (email: string, over: Record<string, unknown> = {}) => ({
  fullName: "Asha Verma",
  email,
  phone: "+91 98765 43210",
  password: "Correct-Horse-9",
  organizationName: "Sunrise Eye Care",
  industry: "Healthcare",
  organizationType: "Eye Hospital",
  department: "Ophthalmology",
  addressLine: "12 MG Road",
  locality: "Indiranagar",
  city: "Bengaluru",
  state: "Karnataka",
  pinCode: "560038",
  country: "India",
  discoverySource: "Google",
  discoveryNotes: "",
  edition: "V1",
  ...over,
});

describe.skipIf(!DEMO_PASSWORD)("hospital sign-up (integration)", () => {
  let app: FastifyInstance;
  const tag = Date.now().toString(36);
  const emails: string[] = [];
  const mail = (n: string) => {
    const e = `signup.${n}.${tag}@example.test`;
    emails.push(e);
    return e;
  };
  const post = (payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: "/auth/signup", payload: payload as object, headers });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    const rows = await queryClient`select distinct tenant_id from users where email = any(${emails})`;
    for (const r of rows) {
      const tenantId = r.tenant_id as string;
      await queryClient`delete from sessions where user_id in (select id from users where tenant_id = ${tenantId})`;
      await queryClient`delete from tenant_profiles where tenant_id = ${tenantId}`;
      await destroyTestTenant(db, { tenantId } as TestTenant);
    }
    await app.close();
    await queryClient.end();
  });

  it("creates the hospital, its branch, a Super Admin and the profile - and signs the owner in", async () => {
    const email = mail("ok");
    const res = await post(valid(email));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email, role: "SUPER_ADMIN", name: "Asha Verma", edition: "BETA_V1_CORE", timezone: "Asia/Kolkata", tenantName: "Sunrise Eye Care" });
    const cookie = res.cookies.find((c) => c.name === "pulseos_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    // Nothing secret leaves the server.
    const text = res.body;
    expect(text).not.toContain("Correct-Horse-9");
    expect(text).not.toMatch(/passwordHash|password_hash|argon2/i);
    expect(text).not.toContain(cookie.value);

    const [u] = await queryClient`select u.id, u.tenant_id, u.password_hash, u.branch_id from users u where u.email = ${email}`;
    expect(u!.password_hash).toMatch(/^\$argon2id\$/);
    const [t] = await queryClient`select name, timezone, edition from tenants where id = ${u!.tenant_id}`;
    expect(t).toMatchObject({ name: "Sunrise Eye Care", timezone: "Asia/Kolkata", edition: "BETA_V1_CORE" });
    const [p] = await queryClient`select * from tenant_profiles where tenant_id = ${u!.tenant_id}`;
    expect(p).toMatchObject({ source: "signup", owner_email: email, industry: "Healthcare", organization_type: "Eye Hospital", department: "Ophthalmology", city: "Bengaluru", state: "Karnataka", pin_code: "560038", country: "India", discovery_source: "Google" });
    expect(p!.owner_phone).toBe("+919876543210");
    const [b] = await queryClient`select id from branches where tenant_id = ${u!.tenant_id}`;
    expect(b!.id).toBe(u!.branch_id);
    // The Ophthalmology template is installed: services and a treatment catalogue exist for the new hospital.
    const [d] = await queryClient`select (select count(*) from departments where tenant_id = ${u!.tenant_id})::int as departments, (select count(*) from specialty_templates where tenant_id = ${u!.tenant_id})::int as services, (select count(*) from treatment_definitions where tenant_id = ${u!.tenant_id})::int as treatments`;
    expect(d!.departments).toBe(1);
    expect(d!.services).toBeGreaterThan(3);
    expect(d!.treatments).toBeGreaterThan(3);

    // The session works, and the new account can sign in with its password.
    const me = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: cookie.value } });
    expect(me.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Correct-Horse-9" } });
    expect(login.statusCode).toBe(200);
  });

  it("never accepts a tenant id (or any unknown field) from the client", async () => {
    const res = await post({ ...valid(mail("tenantid")), tenantId: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(400);
    expect(await queryClient`select 1 from users where email = ${emails[emails.length - 1]!}`).toHaveLength(0);
  });

  it("a double-submit makes exactly one hospital", async () => {
    const email = mail("double");
    const [a, b] = await Promise.all([post(valid(email)), post(valid(email))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await queryClient`select 1 from users where email = ${email}`).toHaveLength(1);
    expect(await queryClient`select 1 from tenant_profiles where owner_email = ${email}`).toHaveLength(1);
    expect(await queryClient`select 1 from tenants where name = 'Sunrise Eye Care' and id in (select tenant_id from users where email = ${email})`).toHaveLength(1);
  });

  it("an email that is already registered (any case, any hospital) is refused without creating anything", async () => {
    const email = mail("dupe");
    expect((await post(valid(email))).statusCode).toBe(201);
    const before = (await queryClient`select count(*)::int as c from tenants`)[0]!.c;
    const again = await post(valid(email.toUpperCase(), { organizationName: "Another Hospital" }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("email_in_use");
    expect((await queryClient`select count(*)::int as c from tenants`)[0]!.c).toBe(before);
    // A seeded demo account's address is taken too.
    expect((await post(valid("eye.admin@pulseos.local"))).statusCode).toBe(409);
  });

  it.each([
    ["an invalid email", { email: "not-an-email" }],
    ["an invalid phone", { phone: "12" }],
    ["a short password", { password: "short1" }],
    ["a password that is the email", { password: "x" }],
    ["a bad PIN code", { pinCode: "12" }],
    ["an unknown discovery source", { discoverySource: "Carrier pigeon" }],
    ["an unknown edition", { edition: "V9" }],
    ["Healthcare without an organization type", { organizationType: undefined }],
    ["Healthcare without a department", { department: undefined }],
    ["a missing organization name", { organizationName: " " }],
  ])("rejects %s with 400 and creates nothing", async (name, over) => {
    const email = mail(`bad-${name.replace(/\W+/g, "-")}`);
    const payload = valid(email, over);
    if (name === "a password that is the email") payload.password = email;
    const res = await post(payload);
    expect(res.statusCode, name).toBe(400);
    expect(await queryClient`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it("'Other' industry needs no healthcare details, and gets no department template", async () => {
    const email = mail("other");
    const res = await post(valid(email, { industry: "Other", organizationType: undefined, department: undefined, organizationName: "Acme Wellness" }));
    expect(res.statusCode).toBe(201);
    const [u] = await queryClient`select tenant_id from users where email = ${email}`;
    expect((await queryClient`select 1 from departments where tenant_id = ${u!.tenant_id}`).length).toBe(0);
  });

  it("a department with no template yet (ENT) is recorded, not faked", async () => {
    const email = mail("ent");
    const res = await post(valid(email, { department: "ENT / Rhinology", organizationName: "City ENT Clinic" }));
    expect(res.statusCode).toBe(201);
    const [u] = await queryClient`select tenant_id from users where email = ${email}`;
    const [p] = await queryClient`select department from tenant_profiles where tenant_id = ${u!.tenant_id}`;
    expect(p!.department).toBe("ENT / Rhinology");
    expect((await queryClient`select 1 from departments where tenant_id = ${u!.tenant_id}`).length).toBe(0);
  });

  it("V2 gets the growth edition", async () => {
    const email = mail("v2");
    const res = await post(valid(email, { edition: "V2", organizationName: "Growth Eye Centre" }));
    expect(res.statusCode).toBe(201);
    expect(res.json().user.edition).toBe("BETA_V2_GROWTH");
  });

  it("a brand-new hospital reports what is still to set up, so the dashboard can guide it", async () => {
    const email = mail("setup");
    const res = await post(valid(email, { organizationName: "Setup Checklist Hospital" }));
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    const status = await app.inject({ method: "GET", url: "/dashboard/setup-status", cookies: { pulseos_session: cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ hasJourneys: false, crmConfigured: true, hasDoctors: false, callingConnected: false, whatsappConnected: false, hasStaff: false });
  });

  it("setup status is for the signed-in hospital's administrators only", async () => {
    expect((await app.inject({ method: "GET", url: "/dashboard/setup-status" })).statusCode).toBe(401);
  });

  it("a cross-origin sign-up request is refused like every other write", async () => {
    const res = await post(valid(mail("evil")), { origin: "https://evil.example" });
    expect(res.statusCode).toBe(403);
  });

  describe.skipIf(!DEV_LOGIN)("Developer Access (development only)", () => {
    it("lists a newly signed-up hospital with the roles that exist, and signs in as them", async () => {
      const email = mail("dev");
      expect((await post(valid(email, { organizationName: "Dev Visible Hospital" }))).statusCode).toBe(201);
      const envs = (await app.inject({ method: "GET", url: "/auth/dev-login/environments" })).json() as { key: string; label: string; roles: { role: string }[] }[];
      const mine = envs.find((e) => e.label === "Dev Visible Hospital");
      expect(mine, "new hospital is listed").toBeTruthy();
      expect(mine!.key).toMatch(/^tenant:[0-9a-f-]{36}$/);
      expect(mine!.roles.map((r) => r.role)).toEqual(["SUPER_ADMIN"]);
      const login = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "SUPER_ADMIN", environment: mine!.key } });
      expect(login.statusCode).toBe(200);
      expect(login.json().user.email).toBe(email);
      // Roles that do not exist in that hospital are not invented.
      expect((await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "DOCTOR", environment: mine!.key } })).statusCode).toBe(404);
    });

    it("never lists or signs in to a hospital that was not made visible", async () => {
      const [anyDemo] = await queryClient`select t.id from tenants t where t.name like 'Edition Test%' limit 1`;
      const envs = (await app.inject({ method: "GET", url: "/auth/dev-login/environments" })).json() as { key: string }[];
      if (anyDemo) expect(envs.some((e) => e.key === `tenant:${anyDemo.id}`)).toBe(false);
      const res = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "SUPER_ADMIN", environment: "tenant:00000000-0000-4000-8000-000000000000" } });
      expect(res.statusCode).toBe(404);
      const bad = await app.inject({ method: "POST", url: "/auth/dev-login", payload: { role: "SUPER_ADMIN", environment: "tenant:not-a-uuid" } });
      expect(bad.statusCode).toBe(400);
    });
  });
});

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient as sql } from "../db/client.js";
import { demoEmail, demoEmailForRole } from "../domain/auth/demo-environments.js";
import { NAMOKAR_CLINIC_HOURS, NAMOKAR_LOGIN_SLUG, NAMOKAR_TENANT_NAME, NAMOKAR_V2_LOGIN_SLUG, NAMOKAR_V2_TENANT_NAME } from "../seed/demo/namokar.js";

// Namokar is TWO tenants: V1 Demo (fictional activity) and V2 Pilot (configuration only, nothing else).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Every table that can hold a patient, an interaction, an integration or any money for a tenant.
const V2_EMPTY_TABLES = [
  "patients", "journeys", "calls", "call_intelligence", "tasks", "appointments", "treatment_opportunities", "consultation_outcomes", "notifications",
  "timeline_events", "conversations", "messages", "conversation_summaries", "revenue_events", "conversion_feedback_events", "campaign_touchpoints",
  "marketing_campaigns", "ads_daily_facts", "ads_sync_runs", "gbp_performance_metrics", "custom_field_values", "activity_log", "outbound_webhooks",
  "connectors", "connector_events", "communication_endpoints", "connector_config_audit_events", "connector_disposition_mappings",
] as const;

describe("Namokar clinic hours constant", () => {
  it("is Monday-Saturday 09:00-16:00, closed Sunday", () => {
    expect(NAMOKAR_CLINIC_HOURS).toEqual({
      mon: ["09:00", "16:00"], tue: ["09:00", "16:00"], wed: ["09:00", "16:00"], thu: ["09:00", "16:00"], fri: ["09:00", "16:00"], sat: ["09:00", "16:00"], sun: null,
    });
  });
  it("gives Namokar V2 its own accounts and Dev Login coordinator", () => {
    expect(demoEmail("namokar-v2", "shivani")).toBe("namokarv2.shivani@pulseos.local");
    expect(demoEmailForRole("namokar-v2", "PATIENT_COORDINATOR")).toBe("namokarv2.shivani@pulseos.local");
    expect(demoEmailForRole("namokar", "PATIENT_COORDINATOR")).toBe("namokar.coordinator@pulseos.local");
  });
});

describe.skipIf(!DEMO_PASSWORD)("Namokar V1 Demo and V2 Pilot (seeded)", () => {
  let app: FastifyInstance;
  let v1: string;
  let v2: string;
  const one = async (q: PromiseLike<unknown>) => (await q) as Record<string, unknown>[];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    [v1, v2] = await Promise.all([NAMOKAR_TENANT_NAME, NAMOKAR_V2_TENANT_NAME].map(async (n) => {
      const [t] = await sql`select id from tenants where name = ${n}`;
      expect(t, `run \`pnpm db:seed\` first (${n})`).toBeTruthy();
      return t!.id as string;
    })) as [string, string];
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  describe("V2 Pilot is configuration only", () => {
    it.each(V2_EMPTY_TABLES)("has zero rows in %s", async (table) => {
      const [{ n }] = (await sql.unsafe(`select count(*)::int as n from "${table}" where tenant_id = $1`, [v2])) as unknown as [{ n: number }];
      expect(n).toBe(0);
    });

    it("is the real pilot shape: one branch, one doctor, one front desk, two coordinators, revenue off, no integrations, 1-hour reminder only", async () => {
      expect(await one(sql`select edition, timezone, login_slug, clinic_hours from tenants where id = ${v2}`)).toEqual([
        { edition: "BETA_V1_CORE", timezone: "Asia/Kolkata", login_slug: NAMOKAR_V2_LOGIN_SLUG, clinic_hours: NAMOKAR_CLINIC_HOURS },
      ]);
      expect(await one(sql`select name, city from branches where tenant_id = ${v2}`)).toEqual([{ name: "Namokar Eye & Oculoplasty Centre", city: "Ashok Vihar, New Delhi" }]);
      expect((await sql`select name from schedule_resources where tenant_id = ${v2} and is_active`).map((r) => r.name)).toEqual(["Dr. Poonam Jain"]);
      const staff = await sql`select role, count(*)::int as n from users where tenant_id = ${v2} group by role`;
      expect(Object.fromEntries(staff.map((r) => [r.role, r.n]))).toEqual({ SUPER_ADMIN: 1, HOSPITAL_ADMIN: 1, DOCTOR: 1, FRONT_DESK: 1, PATIENT_COORDINATOR: 2 });
      expect((await sql`select name, role from users where tenant_id = ${v2}`).map((r) => `${r.name}|${r.role}`).sort()).toEqual([
        "Dr. Poonam Jain|DOCTOR", "Front Desk|FRONT_DESK", "Namokar Admin (placeholder)|HOSPITAL_ADMIN", "Namokar Owner (placeholder)|SUPER_ADMIN", "Shivani|PATIENT_COORDINATOR", "Sushil|PATIENT_COORDINATOR",
      ]);
      expect(await one(sql`select enabled from tenant_capabilities where tenant_id = ${v2} and capability = 'REVENUE_TRACKING'`)).toEqual([{ enabled: false }]);
      expect(await sql`select 1 from connectors where tenant_id = ${v2}`).toHaveLength(0);
      const rules = await sql`select offset_unit from notification_rules where tenant_id = ${v2} and subject = 'APPOINTMENT' and kind = 'REMINDER' and enabled`;
      expect(rules.map((r) => r.offset_unit)).toEqual(["hours"]);
      expect((await sql`select 1 from departments where tenant_id = ${v2} and template_key = 'ophthalmology'`).length).toBe(1);
      expect((await sql`select 1 from treatment_definitions where tenant_id = ${v2}`).length).toBeGreaterThan(0);
      expect((await sql`select 1 from followup_types where tenant_id = ${v2}`).length).toBeGreaterThan(0);
      expect((await sql`select 1 from crm_outcomes where tenant_id = ${v2}`).length).toBeGreaterThan(0);
    });

    it("opens empty through the API (no activity; providers are NOT CONFIGURED because no connector exists)", async () => {
      const login = await app.inject({ method: "POST", url: `/auth/login/tenant/${NAMOKAR_V2_LOGIN_SLUG}`, payload: { email: "namokarv2.admin@pulseos.local", password: DEMO_PASSWORD } });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
      const res = await app.inject({ method: "GET", url: "/dashboard/today", cookies: { pulseos_session: cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ newEnquiries: 0, appointmentsToday: 0 });
    });
  });

  describe("V1 Demo keeps its story", () => {
    it("still has demo data, the new staff names, unassigned work and clinic hours", async () => {
      const [{ p, j, a }] = (await sql`select (select count(*) from patients where tenant_id = ${v1})::int as p, (select count(*) from journeys where tenant_id = ${v1})::int as j, (select count(*) from appointments where tenant_id = ${v1})::int as a`) as unknown as [{ p: number; j: number; a: number }];
      expect(p).toBeGreaterThan(20);
      expect(j).toBeGreaterThan(20);
      expect(a).toBeGreaterThan(10);
      expect((await sql`select name from users where tenant_id = ${v1} and role in ('FRONT_DESK','PATIENT_COORDINATOR') order by email`).map((r) => r.name as string).sort()).toEqual(["Front Desk", "Shivani", "Sushil"]);
      const names = (await sql`select name from users where tenant_id = ${v1}`).map((r) => r.name as string).join("|");
      for (const gone of ["Rohan Desai", "Priya Nambiar", "Neha Arora"]) expect(names).not.toContain(gone);
      expect((await sql`select 1 from calls where tenant_id = ${v1} and agent_name in ('Rohan Desai','Priya Nambiar','Neha Arora')`).length).toBe(0);
      // Work is spread across the three people, plus some Unassigned journeys and tasks.
      const owners = await sql`select owner_user_id from journeys where tenant_id = ${v1}`;
      expect(new Set(owners.filter((r) => r.owner_user_id).map((r) => r.owner_user_id)).size).toBe(3);
      expect(owners.filter((r) => !r.owner_user_id).length).toBeGreaterThanOrEqual(2);
      expect((await sql`select 1 from tasks where tenant_id = ${v1} and assigned_to is null`).length).toBeGreaterThanOrEqual(1);
      expect(await one(sql`select clinic_hours from tenants where id = ${v1}`)).toEqual([{ clinic_hours: NAMOKAR_CLINIC_HOURS }]);
    });

    it("seeds no appointment on a Sunday other than today's live queue", async () => {
      const rows = await sql`
        select count(*)::int as n from appointments
        where tenant_id = ${v1} and extract(dow from scheduled_at at time zone 'Asia/Kolkata') = 0
          and (scheduled_at at time zone 'Asia/Kolkata')::date <> (now() at time zone 'Asia/Kolkata')::date`;
      expect(rows[0]!.n).toBe(0);
    });
  });

  describe("sign-in pages", () => {
    it.each([
      [NAMOKAR_LOGIN_SLUG, "V1 Demo"],
      [NAMOKAR_V2_LOGIN_SLUG, "V2 Pilot"],
    ])("GET /auth/tenants/%s resolves with the %s badge", async (slug, badge) => {
      const res = await app.inject({ method: "GET", url: `/auth/tenants/${slug}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ slug, shortName: "Namokar", badgeLabel: badge });
    });

    it("the old /auth/tenants/namokar slug is gone on the API (the web redirects the page)", async () => {
      expect((await app.inject({ method: "GET", url: "/auth/tenants/namokar" })).statusCode).toBe(404);
    });

    it("each account signs in only through its own tenant's slug", async () => {
      const post = (slug: string, email: string) => app.inject({ method: "POST", url: `/auth/login/tenant/${slug}`, payload: { email, password: DEMO_PASSWORD } });
      for (const who of ["superadmin", "admin", "doctor", "frontdesk", "coordinator", "coordinator2"]) {
        const ok = await post(NAMOKAR_LOGIN_SLUG, `namokar.${who}@pulseos.local`);
        expect(ok.statusCode, `v1 ${who}`).toBe(200);
        expect(ok.json().user.tenantId).toBe(v1);
        expect((await post(NAMOKAR_V2_LOGIN_SLUG, `namokar.${who}@pulseos.local`)).statusCode, `v1 ${who} on v2 page`).toBe(401);
      }
      for (const who of ["superadmin", "admin", "doctor", "frontdesk", "shivani", "sushil"]) {
        const ok = await post(NAMOKAR_V2_LOGIN_SLUG, `namokarv2.${who}@pulseos.local`);
        expect(ok.statusCode, `v2 ${who}`).toBe(200);
        expect(ok.json().user.tenantId).toBe(v2);
        expect((await post(NAMOKAR_LOGIN_SLUG, `namokarv2.${who}@pulseos.local`)).statusCode, `v2 ${who} on v1 page`).toBe(401);
      }
    });
  });

  describe("no duplicates", () => {
    it("has exactly one tenant, branch, doctor, staff set and login config per Namokar tenant", async () => {
      for (const [id, name, slug, staffCount] of [[v1, NAMOKAR_TENANT_NAME, NAMOKAR_LOGIN_SLUG, 6], [v2, NAMOKAR_V2_TENANT_NAME, NAMOKAR_V2_LOGIN_SLUG, 6]] as const) {
        expect(await sql`select 1 from tenants where name = ${name}`).toHaveLength(1);
        expect(await sql`select 1 from tenants where login_slug = ${slug}`).toHaveLength(1);
        expect(await sql`select 1 from branches where tenant_id = ${id}`).toHaveLength(1);
        expect(await sql`select 1 from schedule_resources where tenant_id = ${id} and is_active`).toHaveLength(1);
        expect(await sql`select 1 from users where tenant_id = ${id}`).toHaveLength(staffCount);
        expect(await sql`select 1 from tenant_login_configs where tenant_id = ${id}`).toHaveLength(1);
        expect(await sql`select 1 from tenant_capabilities where tenant_id = ${id}`).toHaveLength(1);
      }
    });

    // Opt-in: the seed wipes EVERY tenant (and every session), so it must not run inside a shared suite by default.
    it.skipIf(!process.env.NAMOKAR_RESEED_TEST)("re-running the seed does not duplicate anything", async () => {
      const count = async () => {
        const out: Record<string, number> = {};
        for (const [label, id] of [["v1", v1], ["v2", v2]] as const) {
          for (const t of ["branches", "users", "schedule_resources", "tenant_login_configs", "tenant_capabilities", "patients"]) {
            out[`${label}.${t}`] = ((await sql.unsafe(`select count(*)::int as n from "${t}" where tenant_id = (select id from tenants where name = $1)`, [label === "v1" ? NAMOKAR_TENANT_NAME : NAMOKAR_V2_TENANT_NAME])) as unknown as [{ n: number }])[0].n;
          }
          void id;
        }
        out.tenants = ((await sql`select count(*)::int as n from tenants where name in (${NAMOKAR_TENANT_NAME}, ${NAMOKAR_V2_TENANT_NAME})`) as unknown as [{ n: number }])[0].n;
        return out;
      };
      const before = await count();
      const run = spawnSync("pnpm", ["db:seed"], { env: process.env, encoding: "utf8", timeout: 180_000 });
      expect(run.status, run.stderr).toBe(0);
      expect(await count()).toEqual(before);
      expect(before["v2.patients"]).toBe(0);
    }, 200_000);
  });
});

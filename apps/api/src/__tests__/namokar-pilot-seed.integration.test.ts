import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LeadsWorkspace, PerformanceDashboard } from "@pulseos/types";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import { NAMOKAR_JOURNEYS, NAMOKAR_LOGIN_SLUG, NAMOKAR_TENANT_NAME } from "../seed/demo/namokar.js";

// The Namokar pilot data must tell ONE consistent story. These tests read the seeded rows (never the seed's own config) and
// check that nothing contradicts anything else, that every stage the pilot talks about is on screen today, and that the numbers
// on the dashboards are the rows - not figures typed into a seed.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("Namokar pilot seed: consistency and coverage", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let tz: string;
  let today: string;
  const sql = queryClient;

  const login = async (email: string) => {
    const res = await app.inject({ method: "POST", url: `/auth/login/tenant/${NAMOKAR_LOGIN_SLUG}`, payload: { email, password: DEMO_PASSWORD } });
    expect(res.statusCode, `${email}: ${res.body}`).toBe(200);
    return res.cookies.find((c) => c.name === "pulseos_session")!.value;
  };
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const [t] = await sql`select id, timezone from tenants where name = ${NAMOKAR_TENANT_NAME}`;
    expect(t, "run `pnpm db:seed` first").toBeTruthy();
    tenantId = t!.id as string;
    tz = t!.timezone as string;
    today = (await sql`select to_char(now() at time zone ${tz}, 'YYYY-MM-DD') as d`)[0]!.d as string;
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  describe("the pilot workspace itself", () => {
    it("is its own tenant with its own sign-in page, a tenant-scoped owner and the five pilot roles", async () => {
      const [t] = await sql`select edition, login_slug from tenants where id = ${tenantId}`;
      expect(t).toMatchObject({ edition: "BETA_V1_CORE", login_slug: "namokar-v1" });
      const roles = (await sql`select distinct role from users where tenant_id = ${tenantId}`).map((r) => r.role as string).sort();
      expect(roles).toEqual(["DOCTOR", "FRONT_DESK", "HOSPITAL_ADMIN", "PATIENT_COORDINATOR", "SUPER_ADMIN"]);
      // Every account signs in through the hospital's own page (and lands in this hospital).
      for (const who of ["superadmin", "admin", "doctor", "frontdesk", "coordinator"]) {
        const res = await app.inject({ method: "POST", url: "/auth/login/tenant/namokar-v1", payload: { email: `namokar.${who}@pulseos.local`, password: DEMO_PASSWORD } });
        expect(res.statusCode, who).toBe(200);
        expect(res.json().user.tenantId).toBe(tenantId);
      }
    });

    it("has revenue switched off by the hospital's own setting: no revenue event, no revenue figure, no revenue workflow", async () => {
      expect((await sql`select 1 from revenue_events where tenant_id = ${tenantId}`).length).toBe(0);
      expect((await sql`select enabled from tenant_capabilities where tenant_id = ${tenantId} and capability = 'REVENUE_TRACKING'`)[0]).toMatchObject({ enabled: false });
      const cookie = await login("namokar.superadmin@pulseos.local");
      const session = (await get(cookie, "/auth/session")).json() as { user: { capabilities: Record<string, boolean> } };
      expect(session.user.capabilities).toMatchObject({ REVENUE_TRACKING: false, WHATSAPP_INBOX: false, CONVERSATION_INTELLIGENCE: false, MARKETING_ANALYTICS: false, ANALYTICS_CORE: true, RUNO_CALLING: true, WHATSAPP_NOTIFICATIONS: true });
      for (const path of ["/analytics/revenue", "/analytics/summary", "/dashboard/executive", "/conversations"]) {
        expect((await get(cookie, path)).statusCode, path).toBe(403);
      }
    });

    it("keeps the website intake a closed door: a token is stored (encrypted), a service is required, only the hospital's origin is allowed", async () => {
      const [c] = await sql`select id, configuration from connectors where tenant_id = ${tenantId} and provider = 'website_form'`;
      expect(c!.configuration).toMatchObject({ requireService: true, fixedSource: "website" });
      const secrets = await sql`select encrypted_payload from connector_secrets where connector_id = ${c!.id}`;
      expect(secrets).toHaveLength(1);
      expect(String(secrets[0]!.encrypted_payload)).not.toMatch(/intake/i); // ciphertext, not JSON
      const res = await app.inject({ method: "POST", url: `/forms/website/${c!.id}`, payload: { submissionId: "x", formId: "namokar-interested", name: "No Token", phone: "+919800000000", service: "Cataract" } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("no contradictions between rows", () => {
    it("no appointment is both no-show and completed, and each carries only the stamps of the states it passed through", async () => {
      const rows = await sql`select status, checked_in_at, waiting_started_at, consultation_started_at, completed_at, no_show_at, cancelled_at from appointments where tenant_id = ${tenantId}`;
      expect(rows.length).toBeGreaterThan(10);
      for (const r of rows) {
        const s = r.status as string;
        if (s === "no_show") {
          expect(r.no_show_at, "no-show stamped").not.toBeNull();
          expect([r.completed_at, r.consultation_started_at, r.checked_in_at], "no-show with a visit").toEqual([null, null, null]);
        }
        if (s === "completed") {
          expect(r.no_show_at, "completed and no-show").toBeNull();
          for (const k of ["checked_in_at", "waiting_started_at", "consultation_started_at", "completed_at"]) expect(r[k], `completed without ${k}`).not.toBeNull();
        }
        if (s === "with_doctor") for (const k of ["checked_in_at", "waiting_started_at", "consultation_started_at"]) expect(r[k], `with doctor without ${k}`).not.toBeNull();
        if (s === "with_doctor") expect(r.completed_at).toBeNull();
        if (s === "waiting") {
          expect(r.checked_in_at).not.toBeNull();
          expect(r.waiting_started_at).not.toBeNull();
          expect(r.consultation_started_at).toBeNull();
        }
        if (s === "checked_in") {
          expect(r.checked_in_at).not.toBeNull();
          expect(r.waiting_started_at).toBeNull();
        }
        // Time only moves forward through the visit.
        const t = (k: string) => (r[k] ? new Date(r[k] as string).getTime() : null);
        const chain = ["checked_in_at", "waiting_started_at", "consultation_started_at", "completed_at"].map(t).filter((x): x is number => x !== null);
        expect(chain, `${s}: stamps out of order`).toEqual([...chain].sort((a, b) => a - b));
      }
    });

    it("with-doctor patients are never earlier than checked in, and nobody is 'waiting' for a visit that has not started", async () => {
      const bad = await sql`
        select a.id from appointments a
        where a.tenant_id = ${tenantId} and a.status in ('checked_in','waiting','with_doctor')
          and to_char(a.scheduled_at at time zone ${tz}, 'YYYY-MM-DD') > ${today}`;
      expect(bad).toHaveLength(0);
    });

    it("a scheduled procedure is backed by a real treatment record: planned date, doctor, branch, and a 'scheduled' journey", async () => {
      const rows = await sql`
        select t.id, t.planned_date, t.scheduled_resource_id, t.scheduled_branch_id, j.stage
        from treatment_opportunities t join journeys j on j.id = t.journey_id
        where t.tenant_id = ${tenantId} and t.status = 'SCHEDULED'`;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) {
        expect(r.planned_date, "scheduled without a date").not.toBeNull();
        expect(r.scheduled_resource_id, "scheduled without a doctor").not.toBeNull();
        expect(r.scheduled_branch_id, "scheduled without a branch").not.toBeNull();
        expect(r.stage).toBe("scheduled");
      }
    });

    it("every journey's stage is explained by its own rows", async () => {
      const bad = await sql`
        select j.id, j.stage from journeys j where j.tenant_id = ${tenantId} and (
          (j.stage in ('attended','consulted','treatment_advised','scheduled','completed') and not exists (select 1 from appointments a where a.journey_id = j.id and a.status in ('checked_in','waiting','with_doctor','completed')))
          or (j.stage = 'booked' and not exists (select 1 from appointments a where a.journey_id = j.id))
          or (j.stage in ('treatment_advised','scheduled','completed') and not exists (select 1 from treatment_opportunities t where t.journey_id = j.id))
        )`;
      expect(bad, JSON.stringify(bad)).toHaveLength(0);
    });

    it("an outcome exists only for a completed visit, and a completed visit's outcome is on the same journey", async () => {
      const bad = await sql`select o.id from consultation_outcomes o join appointments a on a.id = o.appointment_id where o.tenant_id = ${tenantId} and (a.status <> 'completed' or a.journey_id <> o.journey_id)`;
      expect(bad).toHaveLength(0);
    });

    it("every open follow-up belongs to a journey of this hospital, with a real owner or deliberately Unassigned", async () => {
      const bad = await sql`select t.id from tasks t left join journeys j on j.id = t.journey_id where t.tenant_id = ${tenantId} and t.status in ('pending','in_progress') and (j.id is null or j.tenant_id <> t.tenant_id or (t.assigned_to is not null and not exists (select 1 from users u where u.id = t.assigned_to and u.tenant_id = t.tenant_id)))`;
      expect(bad).toHaveLength(0);
    });
  });

  describe("every stage the pilot talks about is on screen today", () => {
    it("shows each derived status, and the lead statuses a telecaller works through", async () => {
      const cookie = await login("namokar.admin@pulseos.local");
      const ws = (await get(cookie, "/leads/workspace?view=all")).json() as LeadsWorkspace;
      const ops = new Set(ws.rows.map((r) => r.operationalStatus));
      for (const s of ["appointment_booked", "appointment_confirmed", "checked_in", "waiting", "with_doctor", "consultation_completed", "treatment_follow_up", "procedure_scheduled", "no_show", "closed"] as const) {
        expect(ops.has(s), `no journey is "${s}"`).toBe(true);
      }
      const leadStatuses = new Set(ws.rows.map((r) => r.leadStatus));
      for (const s of ["new", "uncontacted", "follow_up_due", "appointment_booked", "no_response", "lost"] as const) expect(leadStatuses.has(s), `no lead is "${s}"`).toBe(true);
      expect(ws.counts.missed_visit, "a no-show needing a rebook").toBeGreaterThanOrEqual(1);
      expect(ws.counts.follow_up_due, "callbacks due").toBeGreaterThanOrEqual(3);
      expect(ws.today.overdue, "overdue callbacks").toBeGreaterThanOrEqual(2);
    });

    it("has a completed consultation with no outcome, one with a follow-up outcome, one with a procedure advised, one scheduled", async () => {
      const noOutcome = await sql`select a.id from appointments a left join consultation_outcomes o on o.appointment_id = a.id where a.tenant_id = ${tenantId} and a.status = 'completed' and o.id is null`;
      expect(noOutcome.length, "completed without an outcome").toBeGreaterThanOrEqual(1);
      const outcomes = (await sql`select outcome from consultation_outcomes where tenant_id = ${tenantId}`).map((r) => r.outcome as string);
      expect(outcomes).toEqual(expect.arrayContaining(["FOLLOW_UP_REQUIRED", "TREATMENT_ADVISED", "NO_TREATMENT_REQUIRED"]));
      const treatments = (await sql`select status from treatment_opportunities where tenant_id = ${tenantId}`).map((r) => r.status as string);
      expect(treatments).toEqual(expect.arrayContaining(["ADVISED", "SCHEDULED", "DECISION_PENDING"]));
    });

    it("is spread over the original sources, including Website and Walk-in, and every journey has one", async () => {
      const keys = (await sql`select distinct s.key from journeys j join lead_sources s on s.id = j.source_id where j.tenant_id = ${tenantId}`).map((r) => r.key as string);
      expect(keys).toEqual(expect.arrayContaining(["google", "instagram", "facebook", "phone", "whatsapp", "referral", "walk_in", "website"]));
      expect((await sql`select 1 from journeys where tenant_id = ${tenantId} and source_id is null`).length).toBe(0);
    });
  });

  describe("the flagship Cataract journey", () => {
    it("follows the whole pilot path, in order, on one timeline", async () => {
      const [j] = await sql`
        select j.id, j.patient_id, j.source, j.journey_type, j.stage, p.name from journeys j join patients p on p.id = j.patient_id
        where j.tenant_id = ${tenantId} and j.journey_type = 'Cataract' and j.source = 'google' and j.stage = 'scheduled' and exists (select 1 from appointments a where a.journey_id = j.id and a.status = 'completed')`;
      expect(j, "no flagship journey").toBeTruthy();
      const events = (await sql`select event_type, title from timeline_events where journey_id = ${j!.id} order by occurred_at, created_at`).map((e) => e.event_type as string);
      const order = ["journey_created", "call_logged", "appointment_created", "whatsapp_sent", "appointment_confirmed", "appointment_checked_in", "appointment_waiting", "appointment_with_doctor", "appointment_completed", "surgery_scheduled"];
      let at = -1;
      for (const type of order) {
        const next = events.indexOf(type, at + 1);
        expect(next, `"${type}" missing or out of order in: ${events.join(" > ")}`).toBeGreaterThan(at);
        at = next;
      }
      expect(events).toContain("consultation_outcome_recorded");
      expect(events.filter((e) => e === "appointment_completed"), "one completion line, not two").toHaveLength(1);

      // Its source is still the one it started with, the WhatsApp confirmation is a FIXTURE, and a pre-operative follow-up is due.
      expect(j).toMatchObject({ source: "google" });
      const [n] = await sql`select status, provider_message_id from notifications where journey_id = ${j!.id}`;
      expect(n).toMatchObject({ status: "READ" });
      expect(String(n!.provider_message_id)).toContain("fixture");
      const open = await sql`select f.key from tasks t join followup_types f on f.id = t.followup_type_id where t.journey_id = ${j!.id} and t.status = 'pending'`;
      expect(open.map((r) => r.key)).toContain("surgery_followup");
    });

    it("reads Leads > Patient > Cataract, and Patient and Journey are different pages", async () => {
      const cookie = await login("namokar.admin@pulseos.local");
      const ws = (await get(cookie, "/leads/workspace?view=all")).json() as LeadsWorkspace;
      const row = ws.rows.find((r) => r.journeyType === "Cataract" && r.operationalStatus === "procedure_scheduled");
      expect(row).toBeTruthy();
      const detail = (await get(cookie, `/journeys/${row!.id}`)).json() as { patient: { id: string; name: string }; journey: { id: string; journeyType: string; operationalStatus: string } };
      expect(detail.journey).toMatchObject({ journeyType: "Cataract", operationalStatus: "procedure_scheduled" });
      expect(detail.patient.id).not.toBe(detail.journey.id);
      expect((await get(cookie, `/patients/${detail.patient.id}/360`)).statusCode).toBe(200);
    });
  });

  describe("numbers are the rows", () => {
    it("the Leads counts, the Command Centre and the Performance funnel all reconcile to the journeys table", async () => {
      const cookie = await login("namokar.superadmin@pulseos.local");
      const [{ n: journeysTotal }] = (await sql`select count(*)::int as n from journeys where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      const [{ n: lostTotal }] = (await sql`select count(*)::int as n from journeys where tenant_id = ${tenantId} and stage = 'lost'`) as unknown as { n: number }[];
      const ws = (await get(cookie, "/leads/workspace?view=all")).json() as LeadsWorkspace;
      expect(ws.rows).toHaveLength(journeysTotal);
      expect(ws.counts.all).toBe(journeysTotal);
      expect(ws.counts.lost).toBe(lostTotal);

      const perf = (await get(cookie, "/dashboard/performance")).json() as PerformanceDashboard; // all time
      expect(perf.funnel[0]!.count).toBe(journeysTotal);
      const [{ n: booked }] = (await sql`select count(distinct journey_id)::int as n from appointments where tenant_id = ${tenantId} and status <> 'cancelled'`) as unknown as { n: number }[];
      const [{ n: scheduled }] = (await sql`select count(distinct journey_id)::int as n from treatment_opportunities where tenant_id = ${tenantId} and status in ('SCHEDULED','COMPLETED')`) as unknown as { n: number }[];
      expect(perf.funnel.find((s) => s.key === "booked")!.count).toBeGreaterThanOrEqual(booked); // reached-at-least includes walk-ins who arrived
      expect(perf.funnel.find((s) => s.key === "scheduled")!.count).toBe(scheduled);
      for (let i = 1; i < perf.funnel.length; i++) expect(perf.funnel[i]!.count).toBeLessThanOrEqual(perf.funnel[i - 1]!.count);
      expect(JSON.stringify(perf)).not.toMatch(/revenue|roas/i);
    });

    it("today's strip is counted from today's rows", async () => {
      const cookie = await login("namokar.admin@pulseos.local");
      const strip = (await get(cookie, "/dashboard/today")).json() as { newEnquiries: number; appointmentsToday: number; consultationsCompleted: number };
      const [{ n: created }] = (await sql`select count(*)::int as n from journeys where tenant_id = ${tenantId} and to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') = ${today}`) as unknown as { n: number }[];
      const [{ n: visits }] = (await sql`select count(*)::int as n from appointments where tenant_id = ${tenantId} and to_char(scheduled_at at time zone ${tz}, 'YYYY-MM-DD') = ${today}`) as unknown as { n: number }[];
      const [{ n: done }] = (await sql`select count(*)::int as n from appointments where tenant_id = ${tenantId} and status = 'completed' and to_char(scheduled_at at time zone ${tz}, 'YYYY-MM-DD') = ${today}`) as unknown as { n: number }[];
      expect(strip).toMatchObject({ newEnquiries: created, appointmentsToday: visits, consultationsCompleted: done });
    });

    it("the story configs and the rows agree on how many journeys there are", async () => {
      const [{ n }] = (await sql`select count(*)::int as n from journeys where tenant_id = ${tenantId}`) as unknown as { n: number }[];
      expect(n).toBe(NAMOKAR_JOURNEYS.length);
    });
  });
});

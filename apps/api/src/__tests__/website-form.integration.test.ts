import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { campaignTouchpoints, connectors } from "../db/schema.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, PatientListRow } from "@pulseos/types";

// Integration test: requires DATABASE_URL pointed at a migrated + seeded
// PulseOS dev DB (the website_form ACQUISITION connector is seed data) and
// DEMO_PASSWORD matching the seed run.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

function submission(overrides: Record<string, unknown> = {}) {
  // Each call gets its own phone number by default (tests that specifically
  // exercise the dedupe window pass an explicit shared `phone` override) —
  // otherwise unrelated test cases in this file would collide with each
  // other inside the same 30-minute dedupe window.
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
  return {
    submissionId: `sub-${Date.now()}-${Math.random()}`,
    formId: "landing-fertility-v2",
    name: "Website Test Patient",
    phone: `+91 9${unique}`,
    email: "website.test@example.com",
    service: "IVF Consultation",
    language: "English",
    pageUrl: "https://pulseoshospital.example/ivf",
    utm: { source: "google", medium: "cpc", campaign: "ivf-search-q3", content: "headline-a", term: "ivf cost bangalore" },
    clickIds: { gclid: "gclid-abc123", gbraid: null, wbraid: null, fbclid: null },
    ...overrides,
  };
}

describe.skipIf(!DEMO_PASSWORD)("website form ingestion (Group AC) — integration", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let websiteFormConnectorId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    adminCookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;

    const list = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    websiteFormConnectorId = (list.json() as ConnectorRow[]).find((c) => c.provider === "website_form")!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unknown connector id with 404", async () => {
    const res = await app.inject({
      method: "POST", url: "/forms/website/00000000-0000-0000-0000-000000000000",
      payload: submission(), headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a submission missing required fields (name/phone) with 422", async () => {
    const res = await app.inject({
      method: "POST", url: `/forms/website/${websiteFormConnectorId}`,
      payload: { submissionId: "x", formId: "f1" }, headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("first submission creates a Patient, a website Journey, a touchpoint preserving UTM/click ids, and a follow-up task", async () => {
    const body = submission();
    const res = await app.inject({
      method: "POST", url: `/forms/website/${websiteFormConnectorId}`,
      payload: body, headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const result = res.json() as { ok: true; duplicate: boolean; deduped: boolean; patientId: string; journeyId: string };
    expect(result.duplicate).toBe(false);
    expect(result.deduped).toBe(false);

    const patients = await app.inject({ method: "GET", url: `/patients?search=${encodeURIComponent("Website Test Patient")}`, cookies: { pulseos_session: adminCookie } });
    const rows = patients.json() as PatientListRow[];
    expect(rows.some((p) => p.id === result.patientId)).toBe(true);

    const tasks = await app.inject({ method: "GET", url: `/tasks?patientId=${result.patientId}`, cookies: { pulseos_session: adminCookie } });
    const taskRows = tasks.json() as { id: string; reason: string }[];
    expect(taskRows.length).toBeGreaterThan(0);
    // A brand-new, never-touched enquiry gets a distinct "new_lead" reason —
    // previously indistinguishable from any other ad hoc "manual_task",
    // which is exactly what a Telecaller Workspace "New Leads" view needs
    // to filter on.
    expect(taskRows[0].reason).toBe("new_lead");

    const filtered = await app.inject({ method: "GET", url: `/tasks?patientId=${result.patientId}&reason=new_lead`, cookies: { pulseos_session: adminCookie } });
    expect((filtered.json() as unknown[]).length).toBe(taskRows.length);

    const filteredOut = await app.inject({ method: "GET", url: `/tasks?patientId=${result.patientId}&reason=no_show`, cookies: { pulseos_session: adminCookie } });
    expect((filteredOut.json() as unknown[]).length).toBe(0);

    const [touchpoint] = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, result.journeyId));
    expect(touchpoint.source).toBe("google");
    expect(touchpoint.medium).toBe("cpc");
    expect(touchpoint.utmCampaign).toBe("ivf-search-q3");
    expect(touchpoint.gclid).toBe("gclid-abc123");
    expect(touchpoint.touchType).toBe("first_touch");

    // The Attention Queue is the org-wide "needs an SLA-style call" view —
    // overdue/no-show/uncontacted/treatment-decision. A brand-new, not-yet-due
    // "new_lead" task is a different kind of thing (freshly created, not yet
    // late) and was never meant to land there: AttentionReason has no
    // "new_lead" member at all, so if the query didn't exclude it, the row
    // would render with a blank/undefined reason label.
    const attention = await app.inject({ method: "GET", url: "/dashboard/attention", cookies: { pulseos_session: adminCookie } });
    expect(attention.statusCode).toBe(200);
    const attentionRows = attention.json() as { id: string; reason: string }[];
    expect(attentionRows.some((r) => r.id === taskRows[0]!.id)).toBe(false);
  });

  it("re-posting the same submissionId is idempotent — no duplicate Patient/Journey/task is created", async () => {
    const body = submission();
    const first = await app.inject({ method: "POST", url: `/forms/website/${websiteFormConnectorId}`, payload: body, headers: { "content-type": "application/json" } });
    const second = await app.inject({ method: "POST", url: `/forms/website/${websiteFormConnectorId}`, payload: body, headers: { "content-type": "application/json" } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { duplicate: boolean }).duplicate).toBe(true);

    const firstBody = first.json() as { patientId: string; journeyId: string };
    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, firstBody.journeyId));
    // Exactly the one touchpoint from the first (processed) delivery — the
    // second delivery hit the connector_events idempotency guard and never
    // re-ran processWebsiteFormSubmission.
    expect(touchpoints.length).toBe(1);
  });

  it("a second distinct submission for the same phone within the dedupe window attaches to the existing journey rather than creating a new one, while still recording its own touchpoint", async () => {
    const phone = `+91 91234${String(Date.now()).slice(-5)}`;
    const first = await app.inject({
      method: "POST", url: `/forms/website/${websiteFormConnectorId}`,
      payload: submission({ phone, utm: { source: "meta", medium: "paid_social", campaign: "fertility-awareness", content: null, term: null }, clickIds: { gclid: null, gbraid: null, wbraid: null, fbclid: "fbclid-1" } }),
      headers: { "content-type": "application/json" },
    });
    const firstResult = first.json() as { patientId: string; journeyId: string };

    const second = await app.inject({
      method: "POST", url: `/forms/website/${websiteFormConnectorId}`,
      payload: submission({ phone, utm: { source: "google", medium: "cpc", campaign: "ivf-search-q3", content: null, term: null }, clickIds: { gclid: "gclid-second", gbraid: null, wbraid: null, fbclid: null } }),
      headers: { "content-type": "application/json" },
    });
    const secondResult = second.json() as { deduped: boolean; journeyId: string };

    expect(secondResult.deduped).toBe(true);
    expect(secondResult.journeyId).toBe(firstResult.journeyId);

    const touchpoints = await db.select().from(campaignTouchpoints).where(eq(campaignTouchpoints.journeyId, firstResult.journeyId));
    expect(touchpoints.length).toBe(2);
    const firstTouch = touchpoints.find((t) => t.touchType === "first_touch")!;
    const lastTouch = touchpoints.find((t) => t.touchType === "last_touch")!;
    expect(firstTouch.source).toBe("meta");
    expect(firstTouch.fbclid).toBe("fbclid-1");
    expect(lastTouch.source).toBe("google");
    expect(lastTouch.gclid).toBe("gclid-second");
  });

  it("a disabled connector rejects new submissions", async () => {
    await db.update(connectors).set({ status: "DISABLED" }).where(and(eq(connectors.id, websiteFormConnectorId)));
    const res = await app.inject({ method: "POST", url: `/forms/website/${websiteFormConnectorId}`, payload: submission(), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(403);
    await db.update(connectors).set({ status: "CONNECTED" }).where(and(eq(connectors.id, websiteFormConnectorId)));
  });
});

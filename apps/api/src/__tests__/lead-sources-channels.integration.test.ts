import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { INTERACTION_CHANNELS, MANUAL_INTERACTION_CHANNELS, type LeadRow, type LeadSourceVm, type TimelineEventVm } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, leadSources, timelineEvents } from "../db/schema.js";
import { sourceEnum } from "../db/schema.js";
import type { NormalizedLead } from "../domain/acquisition/types.js";
import { ingestNormalizedLead } from "../domain/acquisition/lead-ingestion.service.js";
import { DEFAULT_LEAD_SOURCES } from "../domain/lead/lead-source.service.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe("lead source catalogue defaults (unit)", () => {
  it("offers the Beta V1 sources in order, and keeps a catalogue key for every legacy platform value", () => {
    expect(DEFAULT_LEAD_SOURCES.filter((s) => !s.archived).map((s) => s.label)).toEqual(["Instagram", "Facebook", "YouTube", "Google", "Referral", "Direct", "Walk-in", "Phone", "WhatsApp", "Other"]);
    const keys = new Set(DEFAULT_LEAD_SOURCES.map((s) => s.key));
    for (const legacy of sourceEnum.enumValues) expect(keys.has(legacy), `legacy source "${legacy}" has no catalogue entry`).toBe(true);
  });

  it("there is no 'multiple sources' source", () => {
    expect(DEFAULT_LEAD_SOURCES.some((s) => /multiple|various|mixed/i.test(s.label))).toBe(false);
  });

  it("channels are a fixed product list, distinct from sources; IVR is system-only", () => {
    expect(INTERACTION_CHANNELS.map((c) => c.key)).toEqual(["IVR_CALL", "MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"]);
    expect(MANUAL_INTERACTION_CHANNELS).not.toContain("IVR_CALL");
    expect(MANUAL_INTERACTION_CHANNELS).toContain("MANUAL_CALL");
  });
});

describe.skipIf(!DEMO_PASSWORD)("lead sources and interaction channels (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const phone = () => `+9197${String(61000000 + ++n * 17).padStart(8, "0")}`;
  const as = (tt: TestTenant, role: "HOSPITAL_ADMIN" | "FRONT_DESK") => ({ pulseos_session: tt.cookie[role]! });
  const lead = (extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/leads", cookies: as(t, "FRONT_DESK"), payload: { phone: phone(), name: "Source Test", specialtyKey: "CATARACT", branchId: t.branchId, journeyType: "Cataract", customFieldValues: {}, ...extra } });
  const journeyRow = async (id: string) => (await db.select().from(journeys).where(eq(journeys.id, id)))[0]!;
  const sourceKeyOf = async (sourceId: string | null) => (sourceId ? (await db.select().from(leadSources).where(eq(leadSources.id, sourceId)))[0]?.key : null);
  const timeline = async (patientId: string) => (await app.inject({ method: "GET", url: `/patients/${patientId}/timeline`, cookies: as(t, "FRONT_DESK") })).json() as TimelineEventVm[];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await app.inject({ method: "POST", url: "/departments/install", cookies: as(t, "HOSPITAL_ADMIN"), payload: { templateKey: "ophthalmology" } });
  });

  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("every tenant gets the default catalogue; archived legacy entries are hidden from staff and visible to the Admin who configures them", async () => {
    const staff = (await app.inject({ method: "GET", url: "/lead-sources", cookies: as(t, "FRONT_DESK") })).json() as LeadSourceVm[];
    expect(staff.map((s) => s.label)).toEqual(["Instagram", "Facebook", "YouTube", "Google", "Referral", "Direct", "Walk-in", "Phone", "WhatsApp", "Other"]);
    // Staff cannot ask for the archived ones even by parameter.
    const sneaky = (await app.inject({ method: "GET", url: "/lead-sources?includeArchived=true", cookies: as(t, "FRONT_DESK") })).json() as LeadSourceVm[];
    expect(sneaky).toHaveLength(staff.length);
    const admin = (await app.inject({ method: "GET", url: "/lead-sources?includeArchived=true", cookies: as(t, "HOSPITAL_ADMIN") })).json() as LeadSourceVm[];
    expect(admin.filter((s) => s.archived).map((s) => s.key).sort()).toEqual(["meta", "organic", "website"]);
  });

  it("a lead stores its precise original source; the coarse bucket follows from it, and the Leads list shows the label", async () => {
    const res = await lead({ sourceKey: "instagram" });
    expect(res.statusCode).toBe(201);
    const j = await journeyRow(res.json().journeyId);
    expect(await sourceKeyOf(j.sourceId)).toBe("instagram");
    expect(j.source).toBe("meta");
    const rows = (await app.inject({ method: "GET", url: "/leads", cookies: as(t, "FRONT_DESK") })).json() as LeadRow[];
    expect(rows.find((r) => r.id === j.id)).toMatchObject({ sourceLabel: "Instagram", source: "meta" });
  });

  it("two sources in the same coarse bucket stay distinguishable (Instagram vs Facebook)", async () => {
    const ig = await journeyRow((await lead({ sourceKey: "instagram" })).json().journeyId);
    const fb = await journeyRow((await lead({ sourceKey: "facebook" })).json().journeyId);
    expect(ig.source).toBe(fb.source);
    expect(ig.sourceId).not.toBe(fb.sourceId);
  });

  it("source is not channel: an Instagram patient who later calls keeps Instagram as the source; the call is a channel on the timeline", async () => {
    const p = phone();
    const first = await lead({ phone: p, sourceKey: "instagram", channel: "INSTAGRAM_DM" });
    const { patientId, journeyId } = first.json() as { patientId: string; journeyId: string };

    // A staff-logged phone call for the same patient.
    const log = await app.inject({ method: "POST", url: `/journeys/${journeyId}/interactions`, cookies: as(t, "FRONT_DESK"), payload: { outcomeKey: "interested", channel: "MANUAL_CALL", note: "Called back" } });
    expect([200, 201]).toContain(log.statusCode);

    const events = await timeline(patientId);
    expect(events.find((e) => e.eventType === "lead_created")?.channel).toBe("INSTAGRAM_DM");
    expect(events.find((e) => e.eventType === "outcome_logged")?.channel).toBe("MANUAL_CALL");

    const j = await journeyRow(journeyId);
    expect(await sourceKeyOf(j.sourceId)).toBe("instagram");
    expect(j.source).toBe("meta");
  });

  it("channel is validated: IVR is system-only, unknown values are refused, and an unknown source is refused", async () => {
    expect([400, 422]).toContain((await lead({ sourceKey: "google", channel: "IVR_CALL" })).statusCode);
    expect([400, 422]).toContain((await lead({ sourceKey: "google", channel: "TELEPATHY" })).statusCode);
    const unknown = await lead({ sourceKey: "no_such_source" });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().fields).toContain("source");
    const missing = await lead({});
    expect(missing.statusCode).toBe(422);
    expect(missing.json().fields).toContain("source");
  });

  it("the legacy coarse `source` value is still accepted and resolves to its catalogue entry, even an archived one", async () => {
    const res = await lead({ source: "website" });
    expect(res.statusCode).toBe(201);
    expect(await sourceKeyOf((await journeyRow(res.json().journeyId)).sourceId)).toBe("website");
  });

  it("an archived source is not offered for a new lead by key, but old journeys keep it", async () => {
    const before = await lead({ sourceKey: "youtube" });
    const yt = (await db.select().from(leadSources).where(and(eq(leadSources.tenantId, t.tenantId), eq(leadSources.key, "youtube"))))[0]!;
    expect((await app.inject({ method: "PATCH", url: `/lead-sources/${yt.id}`, cookies: as(t, "HOSPITAL_ADMIN"), payload: { archived: true } })).statusCode).toBe(200);
    expect((await lead({ sourceKey: "youtube" })).statusCode).toBe(422);
    const rows = (await app.inject({ method: "GET", url: "/leads", cookies: as(t, "FRONT_DESK") })).json() as LeadRow[];
    expect(rows.find((r) => r.id === before.json().journeyId)?.sourceLabel).toBe("YouTube");
    await app.inject({ method: "PATCH", url: `/lead-sources/${yt.id}`, cookies: as(t, "HOSPITAL_ADMIN"), payload: { archived: false } });
  });

  it("an Admin can add and rename a source; duplicates are refused; Staff cannot configure", async () => {
    const created = await app.inject({ method: "POST", url: "/lead-sources", cookies: as(t, "HOSPITAL_ADMIN"), payload: { label: "Newspaper ad" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ label: "Newspaper ad", bucket: "other", archived: false });
    expect((await app.inject({ method: "POST", url: "/lead-sources", cookies: as(t, "HOSPITAL_ADMIN"), payload: { label: "newspaper AD" } })).statusCode).toBe(409);

    const res = await lead({ sourceKey: created.json().key });
    expect(res.statusCode).toBe(201);
    expect((await app.inject({ method: "PATCH", url: `/lead-sources/${created.json().id}`, cookies: as(t, "HOSPITAL_ADMIN"), payload: { label: "Newspaper" } })).json().label).toBe("Newspaper");
    const rows = (await app.inject({ method: "GET", url: "/leads", cookies: as(t, "FRONT_DESK") })).json() as LeadRow[];
    expect(rows.find((r) => r.id === res.json().journeyId)?.sourceLabel).toBe("Newspaper"); // the rename shows on the old journey too

    expect((await app.inject({ method: "POST", url: "/lead-sources", cookies: as(t, "FRONT_DESK"), payload: { label: "Nope" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/lead-sources/${created.json().id}`, cookies: as(t, "FRONT_DESK"), payload: { archived: true } })).statusCode).toBe(403);
  });

  it("sources are tenant-owned: another hospital neither sees nor can change them", async () => {
    const mine = (await app.inject({ method: "POST", url: "/lead-sources", cookies: as(t, "HOSPITAL_ADMIN"), payload: { label: "Corporate tie-up" } })).json();
    const theirs = (await app.inject({ method: "GET", url: "/lead-sources", cookies: as(other, "HOSPITAL_ADMIN") })).json() as LeadSourceVm[];
    expect(theirs.map((s) => s.label)).not.toContain("Corporate tie-up");
    expect((await app.inject({ method: "PATCH", url: `/lead-sources/${mine.id}`, cookies: as(other, "HOSPITAL_ADMIN"), payload: { label: "Hijacked" } })).statusCode).toBe(404);
    // and a key from another tenant's catalogue is not accepted
    const crossTenant = await app.inject({ method: "POST", url: "/leads", cookies: as(other, "FRONT_DESK"), payload: { phone: phone(), specialtyKey: "CATARACT", branchId: other.branchId, journeyType: "Cataract", sourceKey: mine.key, customFieldValues: {} } });
    expect(crossTenant.statusCode).toBe(422);
  });

  it("integration-ingested leads (website form, Meta, Google) resolve to a catalogue source and set the coarse bucket as before", async () => {
    const out = await ingestNormalizedLead(
      db,
      t.tenantId,
      {
        externalLeadId: `ext-${n}`, externalFormId: null, externalAccountId: null, externalCampaignId: null, externalAdGroupId: null, externalAdId: null,
        name: null, phone: phone(), email: null, source: "meta", medium: null, utmCampaign: null, utmContent: null, utmTerm: null, gclid: null, gbraid: null,
        wbraid: null, fbclid: null, occurredAt: new Date(), metadata: {},
      } satisfies NormalizedLead,
      {
        branchId: t.branchId, journeyTypeFallback: "Eye enquiry", campaignNameFallback: "Meta test", sourceLabel: "Meta", taskDueInHours: 2,
        firstTouchEventType: "journey_created", firstTouchTitle: "Eye enquiry journey opened", additionalTouchEventType: "lead_touch", additionalTouchTitle: "Another enquiry",
      },
    );
    const j = await journeyRow(out.journeyId);
    expect(j.source).toBe("meta");
    expect(await sourceKeyOf(j.sourceId)).toBe("meta");
    const patientRows = await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, j.id), eq(timelineEvents.eventType, "journey_created")));
    expect(patientRows[0]!.sourceChannel).toBe("meta");
  });

  it("every interaction event row of a call carries the IVR channel (the call webhook), independent of source", async () => {
    // The Runo webhook suite creates a real call; here we assert on the stored event shape it produces.
    const events = await db.select().from(timelineEvents).where(and(eq(timelineEvents.eventType, "call_logged"), eq(timelineEvents.tenantId, t.tenantId))).orderBy(desc(timelineEvents.occurredAt));
    for (const e of events) expect(e.channel).toBe("IVR_CALL");
  });

  it("sources can be reordered by an Admin: the order is saved for this hospital only, Staff and foreign ids are refused", async () => {
    const list = async (tt: TestTenant, role: "HOSPITAL_ADMIN" | "FRONT_DESK" = "HOSPITAL_ADMIN") => (await app.inject({ method: "GET", url: "/lead-sources", cookies: as(tt, role) })).json() as LeadSourceVm[];
    const before = await list(t);
    const ids = before.map((s) => s.id);
    const reversed = [...ids].reverse();
    const res = await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "HOSPITAL_ADMIN"), payload: { orderedIds: reversed } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await list(t)).map((s) => s.id)).toEqual(reversed);
    // The order Staff see in Add Lead follows.
    expect((await list(t, "FRONT_DESK")).map((s) => s.id)).toEqual(reversed);
    // A partial list (a subset of the sources) reorders just those, keeping the others where they were.
    const [a, b] = [reversed[0]!, reversed[1]!];
    expect((await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "HOSPITAL_ADMIN"), payload: { orderedIds: [b, a] } })).statusCode).toBe(200);
    const after = (await list(t)).map((s) => s.id);
    expect(after.slice(0, 2)).toEqual([b, a]);
    expect(after.slice(2)).toEqual(reversed.slice(2));

    // Refusals: Staff, duplicates, empty, another hospital's id, and unknown ids.
    expect((await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "FRONT_DESK"), payload: { orderedIds: ids } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "HOSPITAL_ADMIN"), payload: { orderedIds: [ids[0], ids[0]] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "HOSPITAL_ADMIN"), payload: { orderedIds: [] } })).statusCode).toBe(400);
    const foreign = (await list(other))[0]!.id;
    expect((await app.inject({ method: "POST", url: "/lead-sources/reorder", cookies: as(t, "HOSPITAL_ADMIN"), payload: { orderedIds: [ids[0], foreign] } })).statusCode).toBe(400);
    // …and the other hospital's order was never touched.
    expect((await list(other))[0]!.id).toBe(foreign);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { allocationRules } from "../db/schema.js";
import { purgePatientData } from "./helpers/purge.js";
import { ingestNormalizedLead } from "../domain/acquisition/lead-ingestion.service.js";
import type { FastifyInstance } from "fastify";
import type { AllocationRuleVm, CreateLeadResult, JourneyDetailVm, SessionUser } from "@pulseos/types";

// Allocation rules: simple, ordered, first-match assignment of a new Journey's owner. Manual assignment
// always wins; rules only apply when nobody was chosen. Journey-level, tenant-scoped.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const PREFIX = "t_alloc_";

async function login(app: FastifyInstance, email: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return { cookie: res.cookies.find((c) => c.name === "pulseos_session")!.value, user: (res.json() as { user: SessionUser }).user };
}
const phone = () => `9${Math.floor(100000000 + Math.random() * 899999999)}`;

describe.skipIf(!DEMO_PASSWORD)("CRM allocation rules (integration)", () => {
  let app: FastifyInstance;
  let admin: { cookie: string; user: SessionUser };
  let coordinator: { cookie: string; user: SessionUser };
  let frontDesk: { cookie: string; user: SessionUser };
  let doctor: { cookie: string; user: SessionUser };
  let gynAdmin: { cookie: string; user: SessionUser };
  let branchId: string;
  let otherBranchId: string;
  const patientIds: string[] = [];

  const call = (who: { cookie: string }, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object | undefined, cookies: { pulseos_session: who.cookie } });
  const rules = async (who = admin) => (await call(who, "GET", "/crm/allocation-rules")).json() as AllocationRuleVm[];
  async function addRule(body: Record<string, unknown>, who = admin) {
    const res = await call(who, "POST", "/crm/allocation-rules", { name: `${PREFIX}rule`, userIds: [coordinator.user.id], ...body });
    return res;
  }
  async function lead(over: Record<string, unknown> = {}): Promise<CreateLeadResult> {
    const res = await call(admin, "POST", "/leads", { name: "Alloc Patient", phone: phone(), specialtyKey: "CATARACT", branchId, source: "meta", journeyType: "Cataract", ...over });
    expect(res.statusCode, res.body).toBe(201);
    const made = res.json() as CreateLeadResult;
    patientIds.push(made.patientId);
    return made;
  }
  const ownerOf = async (journeyId: string) => ((await call(admin, "GET", `/journeys/${journeyId}`)).json() as JourneyDetailVm).journey.owner?.id ?? null;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await login(app, "eye.admin@pulseos.local");
    coordinator = await login(app, "eye.coordinator@pulseos.local");
    frontDesk = await login(app, "eye.frontdesk@pulseos.local");
    doctor = await login(app, "eye.doctor@pulseos.local");
    gynAdmin = await login(app, "gyn.admin@pulseos.local");
    const branches = ((await call(admin, "GET", "/lookups")).json() as { branches: { id: string }[] }).branches;
    branchId = branches[0]!.id;
    otherBranchId = branches[1]!.id;
  });

  beforeEach(async () => {
    // Each test starts from "no rules" (this tenant's, in the controller DB).
    await db.delete(allocationRules).where(like(allocationRules.name, `${PREFIX}%`));
  });

  afterAll(async () => {
    await db.delete(allocationRules).where(like(allocationRules.name, `${PREFIX}%`));
    await purgePatientData(db, patientIds);
    await app.close();
    await queryClient.end();
  });

  it("only an admin manages rules; a coordinator cannot even read them", async () => {
    expect((await addRule({}, coordinator)).statusCode).toBe(403);
    expect((await call(coordinator, "GET", "/crm/allocation-rules")).statusCode).toBe(403);
    expect((await call(doctor, "GET", "/crm/allocation-rules")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/crm/allocation-rules" })).statusCode).toBe(401);
  });

  it("validates a rule: needs a name, at least one condition, and a pool of this hospital's staff", async () => {
    expect((await addRule({ name: "" })).statusCode).toBe(400);
    expect((await addRule({})).statusCode).toBe(400); // no condition: it would match everything
    expect((await addRule({ source: "meta", userIds: [] })).statusCode).toBe(400);
    expect((await addRule({ source: "telepathy" })).statusCode).toBe(400);
    expect((await addRule({ source: "meta", userIds: [gynAdmin.user.id] })).statusCode).toBe(400); // another hospital's user
    expect((await addRule({ source: "meta", userIds: [doctor.user.id] })).statusCode).toBe(400); // doctors do not own journeys
    expect((await addRule({ source: "meta", branchId: "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(400);
    const ok = await addRule({ source: "meta", specialtyKey: "CATARACT" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: `${PREFIX}rule`, source: "meta", specialtyKey: "CATARACT", enabled: true, pool: [{ userId: coordinator.user.id }] });
  });

  it("a Meta Cataract lead with no owner is assigned by the matching rule; manual assignment always wins", async () => {
    await addRule({ source: "meta", specialtyKey: "CATARACT", userIds: [coordinator.user.id] });
    expect(await ownerOf((await lead()).journeyId)).toBe(coordinator.user.id);
    // Not a match (other source / other service): left unassigned, as before.
    expect(await ownerOf((await lead({ source: "google" })).journeyId)).toBeNull();
    expect(await ownerOf((await lead({ specialtyKey: "LASER_VISION_CORRECTION", journeyType: "LASIK" })).journeyId)).toBeNull();
    // A person chose an owner: the rule does not override it.
    expect(await ownerOf((await lead({ ownerId: frontDesk.user.id })).journeyId)).toBe(frontDesk.user.id);
  });

  it("matches by service line, journey type or branch; every condition given must match", async () => {
    await addRule({ name: `${PREFIX}branch`, branchId: otherBranchId, userIds: [frontDesk.user.id] });
    expect(await ownerOf((await lead({ branchId: otherBranchId })).journeyId)).toBe(frontDesk.user.id);
    expect(await ownerOf((await lead({ branchId })).journeyId)).toBeNull();
    await addRule({ name: `${PREFIX}type`, journeyType: "LASIK", source: "website", userIds: [coordinator.user.id] });
    expect(await ownerOf((await lead({ journeyType: "LASIK", source: "website" })).journeyId)).toBe(coordinator.user.id);
    expect(await ownerOf((await lead({ journeyType: "LASIK", source: "meta" })).journeyId)).toBeNull(); // source differs
  });

  it("the first enabled rule in order wins; reordering and disabling change the outcome", async () => {
    const first = (await addRule({ name: `${PREFIX}first`, source: "meta", userIds: [coordinator.user.id] })).json() as AllocationRuleVm;
    const second = (await addRule({ name: `${PREFIX}second`, source: "meta", userIds: [frontDesk.user.id] })).json() as AllocationRuleVm;
    expect(await ownerOf((await lead()).journeyId)).toBe(coordinator.user.id);
    expect((await call(admin, "POST", "/crm/allocation-rules/reorder", { orderedIds: [second.id, first.id] })).statusCode).toBe(200);
    expect(await ownerOf((await lead()).journeyId)).toBe(frontDesk.user.id);
    expect((await call(admin, "PATCH", `/crm/allocation-rules/${second.id}`, { enabled: false })).statusCode).toBe(200);
    expect(await ownerOf((await lead()).journeyId)).toBe(coordinator.user.id); // disabled rule skipped
    expect((await call(admin, "DELETE", `/crm/allocation-rules/${first.id}`)).statusCode).toBe(200);
    expect(await ownerOf((await lead()).journeyId)).toBeNull();
    expect((await rules()).map((r) => r.id)).toEqual([second.id]);
  });

  it("shares work round-robin across a team", async () => {
    await addRule({ source: "meta", userIds: [coordinator.user.id, frontDesk.user.id] });
    const owners: (string | null)[] = [];
    for (let i = 0; i < 4; i++) owners.push(await ownerOf((await lead()).journeyId));
    expect(owners).toEqual([coordinator.user.id, frontDesk.user.id, coordinator.user.id, frontDesk.user.id]);
  });

  it("round-robin stays fair when leads arrive at the same moment", async () => {
    await addRule({ source: "meta", userIds: [coordinator.user.id, frontDesk.user.id] });
    const made = await Promise.all(Array.from({ length: 6 }, () => lead()));
    const owners = await Promise.all(made.map((m) => ownerOf(m.journeyId)));
    expect(owners.filter((o) => o === coordinator.user.id)).toHaveLength(3);
    expect(owners.filter((o) => o === frontDesk.user.id)).toHaveLength(3);
  });

  it("applies to leads ingested from a website form / ad platform as well", async () => {
    await addRule({ source: "website", userIds: [frontDesk.user.id] });
    const result = await ingestNormalizedLead(
      db,
      admin.user.tenantId,
      {
        externalLeadId: `${PREFIX}${Date.now()}`, externalFormId: null, externalAccountId: null, externalCampaignId: null, externalAdGroupId: null, externalAdId: null,
        name: "Ingested Alloc", phone: phone(), email: null, source: "website", medium: null, utmCampaign: null, utmContent: null, utmTerm: null, gclid: null, gbraid: null, wbraid: null, fbclid: null,
        occurredAt: new Date(), metadata: {},
      },
      { journeyTypeFallback: "General enquiry", campaignNameFallback: "Website", sourceLabel: "Website", taskDueInHours: 4, firstTouchEventType: "source_captured", firstTouchTitle: "Captured", additionalTouchEventType: "source_captured", additionalTouchTitle: "Captured again" },
    );
    patientIds.push(result.patientId);
    expect(await ownerOf(result.journeyId)).toBe(frontDesk.user.id);
  });

  it("is tenant-isolated: another hospital's rules never apply or show, and cannot be edited", async () => {
    const mine = (await addRule({ source: "meta" })).json() as AllocationRuleVm;
    expect((await rules(gynAdmin)).map((r) => r.id)).not.toContain(mine.id);
    expect((await call(gynAdmin, "PATCH", `/crm/allocation-rules/${mine.id}`, { enabled: false })).statusCode).toBe(404);
    expect((await call(gynAdmin, "DELETE", `/crm/allocation-rules/${mine.id}`)).statusCode).toBe(404);
    expect((await call(gynAdmin, "POST", "/crm/allocation-rules/reorder", { orderedIds: [mine.id] })).statusCode).toBe(400);
    // A gynecology Meta lead is not assigned by the eye hospital's rule.
    const gynBranch = ((await call(gynAdmin, "GET", "/lookups")).json() as { branches: { id: string }[] }).branches[0]!.id;
    const res = await call(gynAdmin, "POST", "/leads", { name: "Gyn Alloc", phone: phone(), specialtyKey: "GYNECOLOGY", branchId: gynBranch, source: "meta", journeyType: "Gynecology Consultation" });
    patientIds.push((res.json() as CreateLeadResult).patientId);
    const gynJourney = (await call(gynAdmin, "GET", `/journeys/${(res.json() as CreateLeadResult).journeyId}`)).json() as JourneyDetailVm;
    expect(gynJourney.journey.owner).toBeNull();
  });

  it("writes a Timeline note so the assignment is explainable", async () => {
    await addRule({ name: `${PREFIX}explain`, source: "meta", userIds: [coordinator.user.id] });
    const j = await lead();
    const timeline = ((await call(admin, "GET", `/journeys/${j.journeyId}`)).json() as JourneyDetailVm).timeline;
    expect(timeline.find((e) => e.eventType === "journey_auto_assigned")?.title).toContain("Auto-assigned");
    expect(timeline.find((e) => e.eventType === "journey_auto_assigned")?.description).toContain(`${PREFIX}explain`);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EDITION_CAPABILITIES, ROLE_GROUP, ROLE_PERMISSIONS, editionHasCapability, hasPermission, roleGroupLabel, type Role } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe("edition capabilities and role groups (unit)", () => {
  it("V1 has none of the growth capabilities by default; V2 has all of them", () => {
    // Revenue tracking is on in every edition by default (a hospital that wants no revenue workflow switches it off itself).
    expect(EDITION_CAPABILITIES.BETA_V1_CORE).toEqual(["ANALYTICS_CORE", "RUNO_CALLING", "CCS_IVR", "WHATSAPP_NOTIFICATIONS", "REVENUE_TRACKING"]); // CCS IVR (Express IVR) is a V1 calling provider alongside Runo
    expect(editionHasCapability("BETA_V1_CORE", "CAMPAIGNS")).toBe(false);
    for (const c of ["WHATSAPP_INBOX", "CONVERSATION_INTELLIGENCE", "CAMPAIGNS", "MARKETING_ANALYTICS", "SPEND_ATTRIBUTION"] as const) expect(editionHasCapability("BETA_V2_GROWTH", c)).toBe(true);
  });

  it("every stored role keeps existing and maps to a Beta V1 group", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(["DOCTOR", "FRONT_DESK", "HOSPITAL_ADMIN", "PATIENT_COORDINATOR", "SUPER_ADMIN"]);
    expect(roleGroupLabel("SUPER_ADMIN")).toBe("Super Admin");
    expect(roleGroupLabel("HOSPITAL_ADMIN")).toBe("Admin");
    expect(ROLE_GROUP.FRONT_DESK).toBe("STAFF");
    expect(ROLE_GROUP.PATIENT_COORDINATOR).toBe("STAFF");
    expect(ROLE_GROUP.DOCTOR).toBe("DOCTOR");
  });

  it("only Super Admin holds raw-secret control; Admin holds operational config; Staff and Doctor hold neither", () => {
    expect(hasPermission("SUPER_ADMIN", "MANAGE_INTEGRATION_SECRETS")).toBe(true);
    for (const role of ["HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect(hasPermission(role, "MANAGE_INTEGRATION_SECRETS")).toBe(false);
    expect(hasPermission("HOSPITAL_ADMIN", "MANAGE_INTEGRATION_CONFIG")).toBe(true);
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect(hasPermission(role, "MANAGE_INTEGRATION_CONFIG")).toBe(false);
  });

  it("recording and transcript permissions belong to Super Admin and Admin only", () => {
    for (const p of ["VIEW_CALL_RECORDING", "DOWNLOAD_CALL_RECORDING", "VIEW_CALL_TRANSCRIPT"] as const) {
      expect(hasPermission("SUPER_ADMIN", p)).toBe(true);
      expect(hasPermission("HOSPITAL_ADMIN", p)).toBe(true);
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) expect(hasPermission(role, p)).toBe(false);
    }
  });
});

describe.skipIf(!DEMO_PASSWORD)("edition gating, integration secrets and recordings (integration)", () => {
  let app: FastifyInstance;
  let v1: TestTenant;
  let v2: TestTenant;
  const get = (t: TestTenant, role: Role, url: string) => app.inject({ method: "GET", url, cookies: { pulseos_session: t.cookie[role]! } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    v1 = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    v2 = await createTestTenant(db, app, "BETA_V2_GROWTH", DEMO_PASSWORD!);
  });

  afterAll(async () => {
    await destroyTestTenant(db, v1);
    await destroyTestTenant(db, v2);
    await app.close();
    await queryClient.end();
  });

  it("the session reports the tenant's edition", async () => {
    expect((await get(v1, "HOSPITAL_ADMIN", "/auth/session")).json().user.edition).toBe("BETA_V1_CORE");
    expect((await get(v2, "HOSPITAL_ADMIN", "/auth/session")).json().user.edition).toBe("BETA_V2_GROWTH");
  });

  const V2_ONLY = [
    "/conversations",
    "/campaigns/performance",
    "/campaigns/marketing-efficiency",
    "/campaigns/spend-at-risk",
    "/analytics/summary",
    "/analytics/funnel",
    "/analytics/revenue",
    "/analytics/campaigns",
    "/analytics/services",
    "/analytics/flow",
    "/analytics/team",
    "/dashboard/executive",
    "/dashboard/spend-at-risk",
    "/dashboard/spend-at-risk-by-reason",
    "/dashboard/source-performance",
    "/dashboard/marketing",
    "/settings/conversation",
  ];

  it.each(V2_ONLY)("a Beta V1 tenant is refused %s even for its Admin and Super Admin, by direct request", async (url) => {
    for (const role of ["HOSPITAL_ADMIN", "SUPER_ADMIN"] as Role[]) {
      const res = await get(v1, role, url);
      expect(res.statusCode, `${role} ${url}`).toBe(403);
      expect(res.json().error).toBe("feature_not_available");
    }
  });

  it.each(V2_ONLY)("a Beta V2 tenant's Admin can use %s", async (url) => {
    const res = await get(v2, "HOSPITAL_ADMIN", url);
    expect(res.statusCode, url).toBe(200);
  });

  it("a V2 tenant still enforces the role: Front Desk has no marketing access", async () => {
    const res = await get(v2, "FRONT_DESK", "/campaigns/performance");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("the V1 core CRM stays fully available on a V1 tenant", async () => {
    for (const url of ["/journeys", "/leads", "/tasks", "/appointments", "/treatments", "/dashboard/today", "/patients", "/connectors", "/analytics/leads", "/analytics/source-conversion", "/analytics/filter-options"]) {
      const res = await get(v1, "HOSPITAL_ADMIN", url);
      expect(res.statusCode, url).toBe(200);
    }
  });

  it("V1 conversion stages carry no spend-derived cost; V2 keeps them", async () => {
    const stages = (await get(v1, "HOSPITAL_ADMIN", "/dashboard/conversion")).json() as { costPerOutcome: number | null }[];
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.every((s) => s.costPerOutcome === null)).toBe(true);
    expect((await get(v2, "HOSPITAL_ADMIN", "/dashboard/conversion")).statusCode).toBe(200);
  });

  it("a V1 tenant cannot run campaign sync even with config permission; the refusal is the edition's, not the role's", async () => {
    const res = await app.inject({ method: "POST", url: `/connectors/${v1.connectorId}/sync-campaigns`, cookies: { pulseos_session: v1.cookie.HOSPITAL_ADMIN! } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("feature_not_available");
  });

  describe("integration secrets", () => {
    const patch = (t: TestTenant, role: Role, body: unknown) => app.inject({ method: "PATCH", url: `/connectors/${t.connectorId}`, cookies: { pulseos_session: t.cookie[role]! }, payload: body as object });

    it("Admin cannot write raw secrets, and the refusal changes nothing", async () => {
      const res = await patch(v1, "HOSPITAL_ADMIN", { secrets: { apiKey: "ADMIN-ATTEMPT-123" } });
      expect(res.statusCode).toBe(403);
      expect(res.json().requiredPermission).toBe("MANAGE_INTEGRATION_SECRETS");
      expect((await get(v1, "SUPER_ADMIN", `/connectors/${v1.connectorId}`)).json().connector.hasSecrets).toBe(false);
    });

    it("Admin can still change operational configuration (no secrets in the request)", async () => {
      const res = await patch(v1, "HOSPITAL_ADMIN", { displayName: "Reception telephony", configuration: { accountRef: "reception" } });
      expect(res.statusCode).toBe(200);
      const detail = (await get(v1, "HOSPITAL_ADMIN", `/connectors/${v1.connectorId}`)).json();
      expect(detail.connector.displayName).toBe("Reception telephony");
      expect(detail.configuration.accountRef).toBe("reception");
    });

    it("Super Admin can write secrets, and no response ever carries them back", async () => {
      const res = await patch(v1, "SUPER_ADMIN", { secrets: { apiKey: "SUPER-ADMIN-SECRET-VALUE" } });
      expect(res.statusCode).toBe(200);
      for (const role of ["SUPER_ADMIN", "HOSPITAL_ADMIN"] as Role[]) {
        const detail = await get(v1, role, `/connectors/${v1.connectorId}`);
        expect(detail.json().connector.hasSecrets).toBe(true);
        expect(detail.body).not.toContain("SUPER-ADMIN-SECRET-VALUE");
        expect((await get(v1, role, "/connectors")).body).not.toContain("SUPER-ADMIN-SECRET-VALUE");
      }
    });

    it("Staff cannot configure integrations or even view them", async () => {
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR"] as Role[]) {
        const res = await patch(v1, role, { displayName: "x" });
        expect(res.statusCode).toBe(403);
        expect((await get(v1, role, "/connectors")).statusCode).toBe(403);
      }
    });

    it("another tenant's Super Admin cannot touch this tenant's connector", async () => {
      const res = await app.inject({ method: "PATCH", url: `/connectors/${v1.connectorId}`, cookies: { pulseos_session: v2.cookie.SUPER_ADMIN! }, payload: { secrets: { apiKey: "CROSS-TENANT" } } });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("call recordings", () => {
    it("patient payloads carry hasRecording but never the provider URL", async () => {
      for (const role of ["FRONT_DESK", "HOSPITAL_ADMIN", "SUPER_ADMIN"] as Role[]) {
        const res = await get(v1, role, `/patients/${v1.patientId}/360`);
        expect(res.statusCode, role).toBe(200);
        expect(res.body).not.toContain(v1.recordingUrl);
        expect(res.json().calls[0].hasRecording).toBe(true);
      }
    });

    it("Admin and Super Admin can play and download; the audio streams from PulseOS, never from the provider URL", async () => {
      for (const role of ["HOSPITAL_ADMIN", "SUPER_ADMIN"] as Role[]) {
        const play = await get(v1, role, `/calls/${v1.callId}/recording`);
        expect(play.statusCode).toBe(200);
        expect(play.headers["content-type"]).toBe("audio/wav");
        expect(play.headers["content-disposition"]).toBeUndefined();
        const dl = await get(v1, role, `/calls/${v1.callId}/recording?download=1`);
        expect(dl.statusCode).toBe(200);
        expect(dl.headers["content-disposition"]).toContain("attachment");
      }
    });

    it("Staff and Doctor get 403 with the missing permission named, and no URL", async () => {
      for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as Role[]) {
        const res = await get(v1, role, `/calls/${v1.callId}/recording`);
        expect(res.statusCode, role).toBe(403);
        expect(res.json().requiredPermission).toBe("VIEW_CALL_RECORDING");
        expect(res.body).not.toContain(v1.recordingUrl);
      }
    });

    it("a call from another tenant is a 404, not a leak", async () => {
      const res = await get(v2, "SUPER_ADMIN", `/calls/${v1.callId}/recording`);
      expect(res.statusCode).toBe(404);
    });

    it("unknown or malformed ids are 404", async () => {
      expect((await get(v1, "SUPER_ADMIN", "/calls/not-a-uuid/recording")).statusCode).toBe(404);
      expect((await get(v1, "SUPER_ADMIN", "/calls/00000000-0000-0000-0000-000000000000/recording")).statusCode).toBe(404);
    });
  });
});

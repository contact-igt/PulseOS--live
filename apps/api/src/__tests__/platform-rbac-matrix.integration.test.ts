import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PLATFORM_ROLE_PERMISSIONS, type PlatformPermission, type PlatformRole } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";
const PLATFORM_ROLES = Object.keys(PLATFORM_ROLE_PERMISSIONS) as PlatformRole[];

/**
 * Every guarded console capability, probed with a request the guard must decide BEFORE any work happens: an empty or
 * unknown body/target, so an allowed role gets 400/404 (validation / not found) and a refused one gets 403. Nothing changes.
 */
const PROBES: { name: string; permission: PlatformPermission; method: "GET" | "POST" | "PUT" | "PATCH"; url: (t: string) => string; body?: object }[] = [
  { name: "overview", permission: "VIEW_PLATFORM", method: "GET", url: () => "/platform/overview" },
  { name: "tenant directory", permission: "VIEW_PLATFORM", method: "GET", url: () => "/platform/tenants" },
  { name: "user directory", permission: "VIEW_PLATFORM", method: "GET", url: () => "/platform/users" },
  { name: "integrations", permission: "VIEW_PLATFORM", method: "GET", url: () => "/platform/integrations" },
  { name: "health", permission: "VIEW_PLATFORM", method: "GET", url: () => "/platform/health" },
  { name: "create tenant", permission: "CREATE_TENANT", method: "POST", url: () => "/platform/tenants", body: {} },
  { name: "edit tenant", permission: "EDIT_TENANT", method: "PATCH", url: (t) => `/platform/tenants/${t}`, body: {} },
  { name: "tenant lifecycle", permission: "MANAGE_TENANT_LIFECYCLE", method: "POST", url: (t) => `/platform/tenants/${t}/lifecycle`, body: {} },
  { name: "change plan", permission: "MANAGE_ENTITLEMENTS", method: "PUT", url: (t) => `/platform/tenants/${t}/plan`, body: {} },
  { name: "add membership", permission: "MANAGE_MEMBERSHIPS", method: "POST", url: (t) => `/platform/tenants/${t}/members`, body: {} },
  { name: "password reset", permission: "MANAGE_ACCOUNT_ACCESS", method: "POST", url: () => `/platform/memberships/${randomUUID()}/password-reset` },
  { name: "suspend person", permission: "SUSPEND_ACCOUNTS", method: "POST", url: () => `/platform/users/${randomUUID()}/suspend`, body: {} },
  { name: "start support", permission: "START_SUPPORT_SESSION", method: "POST", url: (t) => `/platform/tenants/${t}/support-sessions`, body: {} },
  { name: "enable support edits", permission: "ENABLE_SUPPORT_EDITS", method: "POST", url: () => `/platform/support-sessions/${randomUUID()}/enable-edits`, body: {} },
  { name: "audit trail", permission: "VIEW_AUDIT", method: "GET", url: () => "/platform/audit" },
  { name: "invite staff", permission: "MANAGE_PLATFORM_STAFF", method: "POST", url: () => "/platform/staff", body: {} },
  { name: "platform settings", permission: "MANAGE_PLATFORM_SETTINGS", method: "PUT", url: () => "/platform/settings", body: {} },
];

describe("platform RBAC matrix (integration)", () => {
  let app: FastifyInstance;
  let tenant: TestTenant;
  const staff = new Map<PlatformRole, TestPlatformUser>();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    tenant = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
    for (const role of PLATFORM_ROLES) staff.set(role, await createPlatformUser(db, app, role, PASSWORD));
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  for (const role of PLATFORM_ROLES) {
    for (const probe of PROBES) {
      const allowed = PLATFORM_ROLE_PERMISSIONS[role].includes(probe.permission);
      it(`${role} ${allowed ? "may" : "may NOT"} ${probe.name}`, async () => {
        const res = await app.inject({ method: probe.method, url: probe.url(tenant.tenantId), cookies: asPlatform(staff.get(role)!.cookie), ...(probe.body ? { payload: probe.body } : {}) });
        if (allowed) expect([200, 400, 404]).toContain(res.statusCode);
        else expect(res.statusCode).toBe(403);
      });
    }
  }

  for (const role of ["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "DOCTOR"] as const) {
    it(`a hospital ${role} reaches none of it (401 everywhere)`, async () => {
      for (const probe of PROBES) {
        const res = await app.inject({ method: probe.method, url: probe.url(tenant.tenantId), cookies: { pulseos_session: tenant.cookie[role]! }, ...(probe.body ? { payload: probe.body } : {}) });
        expect(res.statusCode, probe.name).toBe(401);
      }
    });
  }
});

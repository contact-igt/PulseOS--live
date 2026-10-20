import { describe, expect, it } from "vitest";
import { canManagePlatformRole, hasPlatformPermission, lifecycleActionsFor, PLATFORM_ROLE_PERMISSIONS, TENANT_TRANSITIONS, type PlatformPermission, type PlatformRole } from "@pulseos/types";
import { integrationAttention, integrationBucket, isConfiguredIntegration } from "../domain/platform/integration-health.js";

const ROLES = Object.keys(PLATFORM_ROLE_PERMISSIONS) as PlatformRole[];

describe("platform permission matrix", () => {
  const expectations: [PlatformPermission, PlatformRole[]][] = [
    ["VIEW_PLATFORM", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN", "SUPPORT_AGENT", "PLATFORM_AUDITOR"]],
    ["CREATE_TENANT", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN"]],
    ["MANAGE_TENANT_LIFECYCLE", ["PLATFORM_OWNER", "PLATFORM_ADMIN"]],
    ["MANAGE_ENTITLEMENTS", ["PLATFORM_OWNER", "PLATFORM_ADMIN"]],
    ["MANAGE_MEMBERSHIPS", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN"]],
    ["MANAGE_ACCOUNT_ACCESS", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN", "SUPPORT_AGENT"]],
    ["SUSPEND_ACCOUNTS", ["PLATFORM_OWNER", "PLATFORM_ADMIN"]],
    ["START_SUPPORT_SESSION", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN", "SUPPORT_AGENT"]],
    ["ENABLE_SUPPORT_EDITS", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "IMPLEMENTATION_ADMIN"]],
    ["VIEW_AUDIT", ["PLATFORM_OWNER", "PLATFORM_ADMIN", "PLATFORM_AUDITOR"]],
    ["MANAGE_PLATFORM_STAFF", ["PLATFORM_OWNER", "PLATFORM_ADMIN"]],
    ["MANAGE_PLATFORM_SETTINGS", ["PLATFORM_OWNER"]],
  ];
  for (const [permission, allowed] of expectations) {
    it(`${permission}: exactly ${allowed.join(", ")}`, () => {
      expect(ROLES.filter((r) => hasPlatformPermission(r, permission)).sort()).toEqual([...allowed].sort());
    });
  }

  it("the auditor is read-only: view and audit, nothing else", () => {
    expect(PLATFORM_ROLE_PERMISSIONS.PLATFORM_AUDITOR).toEqual(["VIEW_PLATFORM", "VIEW_AUDIT"]);
  });

  it("only a Platform Owner grants or revokes the top roles", () => {
    expect(canManagePlatformRole("PLATFORM_OWNER", "PLATFORM_OWNER")).toBe(true);
    expect(canManagePlatformRole("PLATFORM_OWNER", "PLATFORM_ADMIN")).toBe(true);
    expect(canManagePlatformRole("PLATFORM_ADMIN", "PLATFORM_OWNER")).toBe(false);
    expect(canManagePlatformRole("PLATFORM_ADMIN", "PLATFORM_ADMIN")).toBe(false);
    expect(canManagePlatformRole("PLATFORM_ADMIN", "SUPPORT_AGENT")).toBe(true);
    expect(canManagePlatformRole("IMPLEMENTATION_ADMIN", "SUPPORT_AGENT")).toBe(false);
    expect(canManagePlatformRole("SUPPORT_AGENT", "SUPPORT_AGENT")).toBe(false);
  });
});

describe("tenant lifecycle transitions", () => {
  it("offers only legal actions per status", () => {
    expect(lifecycleActionsFor("DRAFT")).toEqual(["START_ONBOARDING", "ACTIVATE", "ARCHIVE"]);
    expect(lifecycleActionsFor("ONBOARDING")).toEqual(["ACTIVATE", "SUSPEND", "ARCHIVE"]);
    expect(lifecycleActionsFor("ACTIVE")).toEqual(["SUSPEND"]);
    expect(lifecycleActionsFor("SUSPENDED")).toEqual(["REACTIVATE", "ARCHIVE"]);
    expect(lifecycleActionsFor("ARCHIVED")).toEqual(["REACTIVATE"]);
  });

  it("an active hospital is suspended before it can be archived, and suspend/archive are dangerous", () => {
    expect(TENANT_TRANSITIONS.ARCHIVE.from).not.toContain("ACTIVE");
    expect(TENANT_TRANSITIONS.SUSPEND.dangerous).toBe(true);
    expect(TENANT_TRANSITIONS.ARCHIVE.dangerous).toBe(true);
  });
});

describe("integration attention", () => {
  const base = { enabled: true, blockedReason: null, credentialState: "SAVED" as const, health: "HEALTHY" as const, configuration: "CONFIGURED" as const, lastError: null, mode: "LIVE_CONFIGURED" as const };

  it("a healthy configured connection needs nothing", () => {
    expect(integrationAttention(base)).toBeNull();
    expect(integrationBucket(base)).toBe("healthy");
    expect(isConfiguredIntegration(base)).toBe(true);
  });
  it("unreadable credentials, provider errors and partial configuration need attention", () => {
    expect(integrationAttention({ ...base, credentialState: "UNREADABLE" })).toMatch(/cannot be read/);
    expect(integrationAttention({ ...base, health: "UNHEALTHY" })).toMatch(/error/);
    expect(integrationAttention({ ...base, configuration: "PARTIAL" })).toMatch(/partly/);
  });
  it("switched off or never configured is a fact, not a problem", () => {
    expect(integrationAttention({ ...base, enabled: false, health: "UNHEALTHY" })).toBeNull();
    expect(integrationBucket({ ...base, configuration: "NOT_CONFIGURED", health: "UNKNOWN", mode: "NOT_CONFIGURED" })).toBe("not_configured");
  });
  it("sample (fixture) data never counts as a configured connection", () => {
    expect(isConfiguredIntegration({ ...base, mode: "FIXTURE" })).toBe(false);
  });
});

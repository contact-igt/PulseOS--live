import { describe, expect, it } from "vitest";
import type { SetupStatus } from "@pulseos/types";
import { shouldShowWorkspaceWelcome, welcomeSteps } from "../WorkspaceWelcome";

const empty: SetupStatus = { hasJourneys: false, crmConfigured: false, hasDoctors: false, callingConnected: false, whatsappConnected: false, hasStaff: false };

describe("workspace welcome (empty workspace state)", () => {
  it("shows for a workspace with no journeys, never for one with journeys or while loading", () => {
    expect(shouldShowWorkspaceWelcome(empty)).toBe(true);
    expect(shouldShowWorkspaceWelcome({ ...empty, hasJourneys: true })).toBe(false);
    expect(shouldShowWorkspaceWelcome(undefined)).toBe(false);
  });
  it("offers all five first steps to a hospital admin", () => {
    expect(welcomeSteps(empty, "HOSPITAL_ADMIN", () => {}).map((s) => s.key)).toEqual(["lead", "crm", "doctors", "calling", "whatsapp"]);
  });
  it("hides steps the role cannot use", () => {
    const keys = welcomeSteps(empty, "FRONT_DESK", () => {}).map((s) => s.key);
    expect(keys).toContain("lead");
    expect(keys).not.toContain("crm");
    expect(keys).not.toContain("doctors");
  });
});

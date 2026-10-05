import { describe, expect, it } from "vitest";
import { lockedNavItems, navForRole, pathAllowedForRole } from "../nav";

const hrefs = (role: Parameters<typeof navForRole>[0], edition: Parameters<typeof navForRole>[1]) => navForRole(role, edition).flatMap((g) => g.items.map((i) => i.href));

describe("edition-aware navigation", () => {
  it("a Beta V1 tenant's Admin gets the core CRM and none of the growth pages", () => {
    const v1 = hrefs("HOSPITAL_ADMIN", "BETA_V1_CORE");
    // Analytics (operational) is a CORE page for hospital management; marketing & revenue analytics sit inside it on V2.
    for (const core of ["/command-centre", "/my-work", "/leads", "/patients", "/journeys", "/appointments", "/front-desk", "/treatments", "/analytics", "/integrations", "/settings"]) expect(v1).toContain(core);
    for (const growth of ["/inbox", "/campaigns"]) expect(v1).not.toContain(growth);
  });

  it("Analytics is for hospital management only: Front Desk, Coordinator and Doctor never see it", () => {
    for (const role of ["FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as const) {
      expect(hrefs(role, "BETA_V1_CORE")).not.toContain("/analytics");
      expect(hrefs(role, "BETA_V2_GROWTH")).not.toContain("/analytics");
      expect(pathAllowedForRole(role, "/analytics", "BETA_V2_GROWTH")).toBe(false);
    }
    expect(hrefs("SUPER_ADMIN", "BETA_V1_CORE")).toContain("/analytics");
  });

  it("the primary navigation order for an Admin: Command Centre, Leads, My Work, Appointments, Front Desk, Treatments, Analytics, Settings", () => {
    const order = hrefs("HOSPITAL_ADMIN", "BETA_V1_CORE").filter((h) => ["/command-centre", "/leads", "/my-work", "/appointments", "/front-desk", "/treatments", "/analytics", "/settings"].includes(h));
    expect(order).toEqual(["/command-centre", "/leads", "/my-work", "/appointments", "/front-desk", "/treatments", "/analytics", "/settings"]);
  });

  it("a Beta V2 tenant keeps every page it had", () => {
    const v2 = hrefs("HOSPITAL_ADMIN", "BETA_V2_GROWTH");
    for (const growth of ["/inbox", "/campaigns", "/analytics"]) expect(v2).toContain(growth);
  });

  it("the route guard refuses a growth URL on V1 but not on V2 (a stale bookmark is redirected home)", () => {
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/campaigns", "BETA_V1_CORE")).toBe(false);
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/campaigns/abc", "BETA_V1_CORE")).toBe(false);
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/analytics", "BETA_V1_CORE")).toBe(true); // operational analytics is core
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/inbox", "BETA_V1_CORE")).toBe(false);
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/campaigns", "BETA_V2_GROWTH")).toBe(true);
    expect(pathAllowedForRole("HOSPITAL_ADMIN", "/journeys/abc", "BETA_V1_CORE")).toBe(true);
  });

  it("the Inbox is shown dimmed as Beta V2 on V1 for roles that could use it, and never for V2 or Doctor", () => {
    expect(lockedNavItems("FRONT_DESK", "BETA_V1_CORE").map((i) => i.href)).toEqual(["/inbox"]);
    expect(lockedNavItems("FRONT_DESK", "BETA_V2_GROWTH")).toEqual([]);
    expect(lockedNavItems("DOCTOR", "BETA_V1_CORE")).toEqual([]);
  });

  it("Doctor navigation is unchanged by edition", () => {
    expect(hrefs("DOCTOR", "BETA_V1_CORE")).toEqual(hrefs("DOCTOR", "BETA_V2_GROWTH"));
  });
});

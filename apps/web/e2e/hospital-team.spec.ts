import { expect, test } from "@playwright/test";
import type { HospitalTeamMember } from "@pulseos/types";

test("a hospital owner creates a branch-scoped staff account from Team", async ({ page }) => {
  const branch = { id: "82d44938-1ad8-4e0d-9cef-b29c1709e8b3", name: "Main branch" };
  const members: HospitalTeamMember[] = [];
  await page.route(/\/(auth\/session|hospital-team|branches)$/, async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": new URL(page.url()).origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    if (path === "/auth/session") return route.fulfill({ headers, json: { user: {
      id: "owner", name: "Hospital Owner", email: "owner@example.test", role: "SUPER_ADMIN",
      tenantId: "hospital", tenantName: "Demo hospital", branchId: branch.id, branchName: branch.name,
      loginSlug: "demo-hospital", edition: "BETA_V1_CORE", capabilities: {},
    } } });
    if (path === "/branches") return route.fulfill({ headers, json: [branch] });
    if (request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        name: "Demo Coordinator", email: "coordinator@example.test", role: "PATIENT_COORDINATOR",
        branchId: branch.id, password: "Synthetic test password",
      });
      const member: HospitalTeamMember = { id: "coordinator", name: "Demo Coordinator", email: "coordinator@example.test",
        role: "PATIENT_COORDINATOR", branchId: branch.id, branchName: branch.name };
      members.push(member);
      return route.fulfill({ status: 201, headers, json: member });
    }
    return route.fulfill({ headers, json: { items: members } });
  });
  await page.goto("/team");
  await expect(page.getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Add team member" }).click();
  await expect(page.getByRole("option", { name: "Hospital Admin", exact: true })).toHaveCount(1);
  await page.getByLabel("Full name").fill("Demo Coordinator");
  await page.getByLabel("Work email").fill("coordinator@example.test");
  await page.getByLabel("Hospital role").selectOption("PATIENT_COORDINATOR");
  await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption(branch.id);
  await page.getByLabel("Initial password").fill("Synthetic test password");
  await page.getByLabel("Confirm password").fill("Synthetic test password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("row", { name: /Demo Coordinator/ })).toContainText("Main branch");
});

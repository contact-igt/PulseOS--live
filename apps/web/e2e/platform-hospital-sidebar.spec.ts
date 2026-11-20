import { expect, test } from "@playwright/test";
import type { HospitalSidebarLayout } from "@pulseos/types";

test("a Platform Super Admin saves hospital sidebar links", async ({ page }) => {
  const id = "e04edfd0-c83c-4c44-8a2b-e1fb72db87b7";
  let paths: string[] | null = null;
  let layout: HospitalSidebarLayout | null = null;
  const groups = [{ label: "Main", items: [
    { href: "/patients", label: "Patients", roles: ["SUPER_ADMIN"] },
    { href: "/my-work", label: "My Work", roles: ["SUPER_ADMIN", "PATIENT_COORDINATOR"] },
  ] }];
  await page.route(/\/platform\/(me|hospitals(?:\/[^/]+\/sidebar)?)(?:\?|$)/, async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "http://127.0.0.1:53320",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, PATCH, OPTIONS",
      "access-control-allow-headers": "content-type, x-pulseos-platform",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const url = new URL(request.url());
    if (url.pathname.endsWith("/me")) return route.fulfill({ headers, json: {
      id, email: "platform@example.test", role: "PLATFORM_SUPER_ADMIN", permissions: ["hospital:read"],
    } });
    if (url.pathname.endsWith("/hospitals")) return route.fulfill({ headers, json: {
      items: [{ id, tenantId: id, onboardingId: null, name: "Demo Hospital", slug: "demo-hospital" }], hasMore: false,
    } });
    expect(url.searchParams.get("legacy")).toBe("1");
    if (request.method() === "PATCH") {
      expect(request.headers()["x-pulseos-platform"]).toBe("1");
      layout = request.postDataJSON().layout as HospitalSidebarLayout;
      paths = layout.flatMap((group) => group.links.map((link) => link.href));
      expect(layout).toEqual([
        { label: "Daily work", links: [{ href: "/my-work", label: "Tasks" }, { href: "/patients", label: "Patients" }] },
        { label: "Main", links: [] },
      ]);
    }
    return route.fulfill({ headers, json: { paths, layout, groups } });
  });
  await page.goto("/platform/hospital-sidebar");
  await expect(page.getByRole("link", { name: "Hospital Sidebar" })).toBeVisible();
  await page.getByRole("button", { name: /Demo Hospital/ }).click();
  await page.getByLabel("Use default sidebar").uncheck();
  await page.getByRole("button", { name: "Remove link Patients" }).click();
  await page.getByRole("button", { name: "Remove link My Work" }).click();
  await page.getByRole("button", { name: "Add group" }).click();
  const group = page.getByRole("group", { name: "New group 1", exact: true });
  await group.getByLabel("Group name").fill("Daily work");
  const work = page.getByRole("group", { name: "Daily work", exact: true });
  await work.getByLabel("Add navigation link").selectOption("/patients");
  await work.getByLabel("Add navigation link").selectOption("/my-work");
  await work.getByLabel("Label for /my-work").fill("Tasks");
  await work.getByRole("button", { name: "Move Tasks up" }).click();
  await work.getByRole("button", { name: "Move Daily work up" }).click();
  await page.getByRole("button", { name: "Save sidebar" }).click();
  await expect(page.getByText("Hospital sidebar saved.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /Demo Hospital/ }).click();
  await expect(page.getByLabel("Label for /my-work")).toHaveValue("Tasks");
  await expect(page.getByLabel("Group name").first()).toHaveValue("Daily work");
});

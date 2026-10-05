import { test, expect } from "@playwright/test";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function overflowX(page: import("@playwright/test").Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

const PAGES_BY_ROLE: { email: string; paths: string[] }[] = [
  { email: "gyn.admin@pulseos.local", paths: ["/command-centre", "/patients", "/journeys"] },
  { email: "gyn.frontdesk@pulseos.local", paths: ["/front-desk", "/appointments"] },
  { email: "gyn.coordinator@pulseos.local", paths: ["/my-work", "/treatments", "/inbox"] },
  { email: "gyn.doctor@pulseos.local", paths: ["/doctor-home"] },
];

test.describe("No horizontal overflow", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  for (const { email, paths } of PAGES_BY_ROLE) {
    for (const viewport of [
      { label: "desktop", width: 1440, height: 900 },
      { label: "tablet", width: 768, height: 1024 },
      { label: "mobile", width: 390, height: 844 },
    ]) {
      test(`${paths.join(", ")} (${email.split("@")[0]}) at ${viewport.label}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await login(page, email);
        for (const path of paths) {
          if (page.url().endsWith(path)) {
            // already there from login redirect
          } else {
            await page.goto(path);
          }
          await page.waitForLoadState("networkidle");
          expect(await overflowX(page), `${path} overflows horizontally at ${viewport.label}`).toBeLessThanOrEqual(0);
        }
      });
    }
  }

  test("mobile: sidebar is off-canvas by default and opens via the hamburger button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "gyn.admin@pulseos.local");

    const sidebar = page.getByTestId("sidebar");
    await expect(sidebar).not.toBeInViewport();

    await page.getByTestId("mobile-menu-button").click();
    await expect(sidebar).toBeInViewport();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible();

    await page.getByTestId("sidebar-backdrop").click();
    await expect(sidebar).not.toBeInViewport();
  });
});

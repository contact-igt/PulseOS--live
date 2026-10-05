import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Screenshot loop for the Analytics workspace + Command Centre.
//   SHOT_WIDTHS=1440,1280 SHOT_TABS=overview pnpm exec playwright test e2e/analytics-screenshots.spec.ts --output=<private dir>
// Output: review-artifacts/s6-pages/analytics/

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const API_REDIRECT = process.env.API_REDIRECT;
const OUT = path.resolve(__dirname, "../../../review-artifacts/s6-pages/analytics");
const WIDTHS = (process.env.SHOT_WIDTHS ?? "1440,1280,1024,768,390").split(",").map(Number);
const TABS = (process.env.SHOT_TABS ?? "command-centre,overview,acquisition,journey,revenue,team").split(",");
// Tall viewports: the app scrolls inside <main>, so a taller window is what captures a whole page.
const HEIGHT: Record<number, number> = { 1440: 1900, 1280: 1900, 1024: 2300, 768: 3000, 390: 4200 };

async function devLogin(page: Page) {
  if (API_REDIRECT) await page.context().route(`${API}/**`, (route) => route.continue({ url: route.request().url().replace(API, API_REDIRECT) }));
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/\/command-centre/);
}

test.describe("Analytics screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  for (const width of WIDTHS) {
    test(`width ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT[width] ?? 900 });
      await devLogin(page);
      for (const tab of TABS) {
        await page.goto(tab === "command-centre" ? "/command-centre" : `/analytics?tab=${tab}`);
        await expect(page.getByTestId(tab === "command-centre" ? "command-centre" : "analytics-page")).toBeVisible();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `${tab}-${width}.png`), fullPage: true });
      }
    });
  }
});

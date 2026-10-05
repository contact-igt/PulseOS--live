import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Screenshots + horizontal-overflow check for the Leads list and Journey Detail
// page at five widths. Output: review-artifacts/s6-pages/journey-leads/

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const OUT = path.resolve(__dirname, "../../../review-artifacts/s6-pages/journey-leads");
const WIDTHS = [1440, 1280, 1024, 768, 390];

async function devLogin(page: Page, role: "HOSPITAL_ADMIN" | "FRONT_DESK") {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(role === "FRONT_DESK" ? /front-desk/ : /command-centre/);
}

async function journeyId(page: Page, name: string): Promise<string> {
  const rows = (await (await page.request.get(`${API}/leads`)).json()) as { id: string; patientName: string }[];
  return rows.find((r) => r.patientName === name)!.id;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Journey + Leads screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  for (const width of WIDTHS) {
    test(`leads + journey pages at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width <= 768 ? 1000 : 900 });
      await devLogin(page, "HOSPITAL_ADMIN");
      const geetha = await journeyId(page, "Geetha Bhat");
      const abhishek = await journeyId(page, "Abhishek Nayak");

      await page.goto("/leads");
      await expect(page.getByTestId(`lead-row-${geetha}`).or(page.getByTestId(`lead-card-${geetha}`))).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await overflow(page), `/leads overflows at ${width}`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: path.join(OUT, `leads-${width}.png`) });

      for (const [name, id] of [["cataract-geetha", geetha], ["keratoconus-abhishek", abhishek]] as const) {
        await page.goto(`/journeys/${id}`);
        await expect(page.getByTestId("journey-detail")).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(await overflow(page), `/journeys/${name} overflows at ${width}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: path.join(OUT, `journey-${name}-${width}.png`), fullPage: true });
      }
    });
  }

  test("extra states: assign dialog, bulk bar, Front Desk view, not found", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    const geetha = await journeyId(page, "Geetha Bhat");
    const tanvi = await journeyId(page, "Tanvi Shetty");
    const zoya = await journeyId(page, "Zoya Khan");
    await page.goto("/leads");
    await page.getByTestId(`assign-owner-${geetha}`).click();
    await expect(page.getByTestId("assign-owner-dialog")).toBeVisible();
    await page.waitForTimeout(400); // let the dialog enter animation settle
    await page.screenshot({ path: path.join(OUT, "leads-assign-dialog-1440.png") });
    await page.keyboard.press("Escape");
    await page.getByTestId(`lead-select-${tanvi}`).check();
    await page.getByTestId(`lead-select-${zoya}`).check();
    await expect(page.getByTestId("bulk-bar")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "leads-bulk-bar-1440.png") });
    await page.goto("/journeys/00000000-0000-4000-8000-000000000000");
    await expect(page.getByTestId("journey-not-found")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "journey-not-found-1440.png") });

    await page.context().clearCookies();
    await devLogin(page, "FRONT_DESK");
    await page.goto(`/journeys/${geetha}`);
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: path.join(OUT, "journey-frontdesk-1440.png"), fullPage: true });
  });
});

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Screenshot loop for Patient 360, Treatments and Doctor Home (Ophthalmology demo), headless.
// Output: review-artifacts/s6-pages/p360-treatments-doctor/<page>-<width>.png

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OUT = path.resolve(__dirname, "../../../review-artifacts/s6-pages/p360-treatments-doctor");
const WIDTHS: [number, number][] = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]];

type RoleKey = "HOSPITAL_ADMIN" | "DOCTOR";
async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(role === "DOCTOR" ? /\/doctor-home/ : /\/command-centre/);
}

async function shot(page: Page, name: string, width: number) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
}

test.describe("Patient 360 / Treatments / Doctor Home screenshots", () => {
  test.setTimeout(120_000); // five widths x several pages of full-page screenshots take longer than the 30s default
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  test("admin: Patient 360 x3 and Treatments at five widths", async ({ page }) => {
    await devLogin(page, "HOSPITAL_ADMIN");
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      for (const [patient, slug] of [["Geetha Bhat", "p360-cataract"], ["Abhishek Nayak", "p360-keratoconus"], ["Sneha Kamath", "p360-laser-prk"]] as const) {
        await page.goto(`/patients?q=${encodeURIComponent(patient)}`);
        await page.locator("tbody tr", { hasText: patient }).first().click();
        await expect(page.getByTestId("patient-360")).toBeVisible();
        await shot(page, slug, w);
      }
      await page.goto("/treatments");
      await expect(page.getByTestId("treatments-page")).toBeVisible();
      await shot(page, "treatments", w);
      await page.goto("/patients");
      await expect(page.getByTestId("patients-page")).toBeVisible();
      await shot(page, "patients", w);
    }
  });

  test("doctor: Doctor Home at five widths", async ({ page }) => {
    await devLogin(page, "DOCTOR");
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/doctor-home");
      await expect(page.getByTestId("doctor-home")).toBeVisible();
      await shot(page, "doctor-home", w);
    }
  });
});

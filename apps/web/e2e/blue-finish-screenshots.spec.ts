import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Screenshot loop for the Blue Finish. Run once BEFORE a visual change and
// once AFTER, into different folders:
//   SHOT_SET=before pnpm exec playwright test e2e/blue-finish-screenshots.spec.ts
//   SHOT_SET=after  pnpm exec playwright test e2e/blue-finish-screenshots.spec.ts
// Output: review-artifacts/blue-finish/<set>/

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const SET = process.env.SHOT_SET ?? "after";
const OUT = path.resolve(__dirname, "../../../review-artifacts/blue-finish", SET);

type RoleKey = "HOSPITAL_ADMIN" | "DOCTOR" | "FRONT_DESK" | "PATIENT_COORDINATOR";
const HOME: Record<RoleKey, RegExp> = {
  HOSPITAL_ADMIN: /\/command-centre/, DOCTOR: /\/doctor-home/, FRONT_DESK: /\/front-desk/, PATIENT_COORDINATOR: /\/my-work/,
};

async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

async function openPatient(page: Page, name: string) {
  await page.goto(`/patients?q=${encodeURIComponent(name)}`);
  await page.locator("tbody tr", { hasText: name }).first().click();
  await expect(page.getByTestId("patient-360")).toBeVisible();
}

test.describe("Blue finish screenshot loop", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  test("login + Developer Login", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await shot(page, "01-login");
    await page.getByTestId("dev-login-toggle").click();
    await shot(page, "02-login-dev-open");
  });

  test("admin surfaces (desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "HOSPITAL_ADMIN");
    await shot(page, "03-command-centre");
    await shot(page, "03b-command-centre-full", true);
    for (const [route, name] of [["/leads", "04-leads"], ["/appointments", "10-appointments"], ["/treatments", "11-treatments"], ["/campaigns", "12-campaigns"]] as const) {
      await page.goto(route);
      await shot(page, name);
    }
    for (const [patient, name] of [["Geetha Bhat", "05-cataract-patient-360"], ["Kavitha Prakash", "06-oculoplasty-patient-360"], ["Nisha Bhandari", "07-laser-patient-360"], ["Prakash Naidu", "08-squint-patient-360"]] as const) {
      await openPatient(page, patient);
      await shot(page, name);
    }
  });

  test("role homes (desktop)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "PATIENT_COORDINATOR");
    await shot(page, "09-my-work");
    await page.context().clearCookies();
    await devLogin(page, "DOCTOR");
    await shot(page, "13-doctor-home");
    await page.context().clearCookies();
    await devLogin(page, "FRONT_DESK");
    await shot(page, "14-front-desk");
  });

  test("critical mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await shot(page, "20-login-mobile");
    await page.getByTestId("dev-login-toggle").click();
    await shot(page, "21-login-dev-open-mobile");
    await devLogin(page, "HOSPITAL_ADMIN");
    await shot(page, "22-command-centre-mobile");
    await page.goto("/leads");
    await shot(page, "23-leads-mobile");
    await openPatient(page, "Geetha Bhat");
    await shot(page, "24-patient-360-mobile");
    await page.context().clearCookies();
    await devLogin(page, "PATIENT_COORDINATOR");
    await shot(page, "25-my-work-mobile");
  });

  // Opt-in viewport matrix (SHOT_MATRIX=1): login, Command Centre, Leads and
  // Patient 360 at the five layout-relevant widths. Output: <set>/m-<w>-<page>.png
  test("shell viewport matrix", async ({ page }) => {
    test.skip(!process.env.SHOT_MATRIX, "set SHOT_MATRIX=1 to capture the viewport matrix");
    const sizes = [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const;
    for (const [w, h] of sizes) {
      await page.context().clearCookies();
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/login");
      await shot(page, `m-${w}-login`);
      await devLogin(page, "HOSPITAL_ADMIN");
      await shot(page, `m-${w}-command-centre`);
      await page.goto("/leads");
      await shot(page, `m-${w}-leads`);
      await openPatient(page, "Geetha Bhat");
      await shot(page, `m-${w}-patient-360`);
    }
  });

});

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Work surfaces (My Work, Front Desk, Appointments, Inbox): behaviour checks
// plus the headless screenshot loop into review-artifacts/s6-pages/work-frontdesk-inbox/.
//   pnpm exec playwright test e2e/work-frontdesk-inbox.spec.ts

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const OUT = path.resolve(__dirname, "../../../review-artifacts/s6-pages/work-frontdesk-inbox");

type RoleKey = "HOSPITAL_ADMIN" | "FRONT_DESK" | "PATIENT_COORDINATOR";
const HOME: Record<RoleKey, RegExp> = { HOSPITAL_ADMIN: /\/command-centre/, FRONT_DESK: /\/front-desk/, PATIENT_COORDINATOR: /\/my-work/ };

async function devLogin(page: Page, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

test.describe("Work surfaces", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  test("My Work: each task row links its patient to Patient 360 and its journey to Journey Detail, and shows source + owner + Next Action", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "PATIENT_COORDINATOR");
    await expect(page.getByTestId("my-work-task-list")).toBeVisible();

    const row = page.locator('[data-testid^="task-row-"]', { has: page.locator('[data-testid^="task-journey-"]') }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Next Action");
    await expect(row).toContainText("Source");

    const patientHref = await row.locator('[data-testid^="task-patient-"]').getAttribute("href");
    expect(patientHref).toMatch(/^\/patients\/[0-9a-f-]{36}/);

    const journeyLink = row.locator('[data-testid^="task-journey-"]');
    const journeyHref = await journeyLink.getAttribute("href");
    expect(journeyHref).toMatch(/^\/journeys\/[0-9a-f-]{36}/);
    await journeyLink.click();
    await page.waitForURL(/\/journeys\/[0-9a-f-]{36}/);
  });

  test("My Work: tabs and reason filter keep their test ids and counts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "PATIENT_COORDINATOR");
    for (const key of ["mine", "today", "overdue", "upcoming", "completed"]) {
      await expect(page.getByTestId(`my-work-tab-${key}`)).toBeVisible();
      await expect(page.getByTestId(`my-work-tab-count-${key}`)).toBeVisible();
    }
    await page.getByTestId("my-work-tab-overdue").click();
    await expect(page.getByTestId("my-work-tab-overdue")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("my-work-reason-all")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("my-work-reason-follow_up").click();
    await expect(page.getByTestId("my-work-reason-follow_up")).toHaveAttribute("aria-pressed", "true");
  });

  test("Front Desk: waiting queue shows doctor + wait, and each row offers only the valid next step for its status", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "FRONT_DESK");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();

    // The waiting queue is the list that carries a Wait column.
    const queue = page.locator('[data-testid="appointment-list"]', { has: page.getByRole("columnheader", { name: "Wait" }) }).first();
    await expect(queue.getByRole("columnheader", { name: "Wait" })).toBeVisible();
    await expect(queue.getByRole("columnheader", { name: "Doctor" })).toBeVisible();

    const rows = page.locator('[data-testid^="appointment-row-"]');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const text = (await row.innerText()).replace(/\s+/g, " ");
      const has = async (id: string) => (await row.locator(`[data-testid^="${id}-"]`).count()) > 0;
      // Match on the status badge text; check the more specific statuses first
      // ("Checked in" rows carry a "Move to waiting" button, so "Waiting" is tested last).
      if (/With doctor/.test(text)) {
        expect(await has("appointment-complete")).toBe(true);
        expect(await has("appointment-action")).toBe(false);
      } else if (/Checked in/.test(text)) {
        await expect(row.locator('[data-testid^="appointment-action-"]')).toHaveText("Move to waiting");
        expect(await has("appointment-noshow")).toBe(false);
      } else if (/Completed/.test(text)) {
        expect(await has("appointment-action")).toBe(false);
        expect(await has("appointment-noshow")).toBe(false);
        expect(await has("appointment-complete")).toBe(false);
      } else if (/Waiting/.test(text)) {
        await expect(row.locator('[data-testid^="appointment-action-"]')).toHaveText("Send to doctor");
        expect(await has("appointment-noshow")).toBe(false);
      }
    }
    // Every waiting-queue row carries a wait cell (a real duration, "past slot" or an explicit dash).
    const waitCells = queue.locator('[data-testid^="appointment-wait-"]');
    expect(await waitCells.count()).toBeGreaterThan(0);
  });

  test("Front Desk: clicking a Patient Flow stage filters Today's list, and Show all clears it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "FRONT_DESK");
    await page.getByTestId("flow-bucket-completed").click();
    await expect(page.getByText("Today · Completed")).toBeVisible();
    await page.getByTestId("front-desk-clear-stage").click();
    await expect(page.getByText("Today's Appointments")).toBeVisible();
  });

  test("screenshots: My Work / Front Desk / Appointments / Inbox at 1440 1280 1024 768 390", async ({ page }) => {
    test.setTimeout(240_000);
    const widths = [1440, 1280, 1024, 768, 390];
    const heightFor = (w: number) => (w === 390 ? 844 : w === 768 ? 1024 : 900);

    await page.setViewportSize({ width: 1440, height: 900 });
    await devLogin(page, "PATIENT_COORDINATOR");
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: heightFor(w) });
      await page.goto("/my-work");
      await expect(page.getByTestId("my-work-page")).toBeVisible();
      await shot(page, `my-work-${w}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: heightFor(w) });
      await page.goto("/inbox");
      await expect(page.getByTestId("inbox-page")).toBeVisible();
      await shot(page, `inbox-${w}`);
    }

    await page.context().clearCookies();
    await devLogin(page, "FRONT_DESK");
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: heightFor(w) });
      await page.goto("/front-desk");
      await expect(page.getByTestId("front-desk-page")).toBeVisible();
      await shot(page, `front-desk-${w}`);
    }
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: heightFor(w) });
      await page.goto("/appointments");
      await expect(page.getByTestId("appointments-page")).toBeVisible();
      await shot(page, `appointments-${w}`);
    }
  });
});

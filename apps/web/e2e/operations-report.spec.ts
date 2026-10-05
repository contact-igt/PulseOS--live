import fs from "node:fs";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";
import { test, expect, type Page } from "@playwright/test";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Command Centre — Operations report", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("Beta V1 admin: period + filters drive the report, survive refresh, chart ⇄ table, and export a real Excel file", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await login(page, "eyev1.admin@pulseos.local");
    await page.getByTestId("cc-tab-report").click();
    await expect(page).toHaveURL(/cc=report/);
    await expect(page.getByTestId("report-kpis")).toBeVisible();
    await expect(page.getByTestId("report-period")).toContainText("Asia/Kolkata");

    // Period: the API is the source of truth — the page shows exactly what /reports/operations returns.
    const responsePromise = page.waitForResponse((r) => r.url().includes("/reports/operations") && r.url().includes("range=30d"));
    await pickPeriod(page, "report", "30d");
    const body = (await (await responsePromise).json()) as { kpis: { newEnquiries: number } };
    await expect(page.getByTestId("report-kpi-new")).toContainText(String(body.kpis.newEnquiries));

    // A filter becomes a chip and goes to the server.
    const filtered = page.waitForResponse((r) => r.url().includes("/reports/operations") && r.url().includes("service=Cataract"));
    await page.getByTestId("report-filter-service").selectOption("Cataract");
    await filtered;
    await expect(page.getByTestId("report-chips")).toContainText("Service: Cataract");

    // Refresh keeps the view.
    await page.reload();
    await expectPeriod(page, "report", "30d");
    await expect(page.getByTestId("report-filter-service")).toHaveValue("Cataract");

    // Chart ⇄ table.
    await expect(page.getByTestId("report-daily-chart")).toBeVisible();
    await page.getByTestId("report-daily-table-tab").click();
    await expect(page.getByTestId("report-daily-table").locator("tbody tr")).toHaveCount(30);

    // Export → a genuine .xlsx (zip container), named after the kind and period.
    await page.getByTestId("report-export").click();
    const download = page.waitForEvent("download");
    await page.getByTestId("report-export-enquiries").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^pulseos-enquiries-.*\.xlsx$/);
    const bytes = fs.readFileSync((await file.path())!);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    // Reset clears every report filter.
    await page.getByTestId("report-reset").click();
    await expectPeriod(page, "report", "7d");
    await expect(page.getByTestId("report-chips")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("custom range in hospital days, and a 390px phone has no page overflow with filters in a sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eye.admin@pulseos.local");
    await page.goto("/command-centre?cc=report");
    await pickPeriod(page, "report", "custom");
    await expect(page.getByTestId("report-custom-dates")).toBeVisible();
    await expect(page).toHaveURL(/rRange=custom&rFrom=\d{4}-\d{2}-\d{2}&rTo=\d{4}-\d{2}-\d{2}/);
    await page.getByTestId("report-filters-open").click();
    await expect(page.getByTestId("report-filters-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("report-filters-sheet")).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("staff never get the report: the API refuses it", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const status = await page.evaluate(async () => (await fetch("http://localhost:4310/reports/operations", { credentials: "include" })).status);
    expect(status).toBe(403);
    const exportStatus = await page.evaluate(async () => (await fetch("http://localhost:4310/reports/export?kind=enquiries", { credentials: "include" })).status);
    expect(exportStatus).toBe(403);
  });
});

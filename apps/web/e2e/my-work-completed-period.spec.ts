import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";

// My Work's Completed tab is a history: it covers a chosen window (default last 7 days) and keeps it in the URL. The
// live buckets (Overdue / Today / Upcoming) never show a period control.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|doctor-home|front-desk|my-work/);
}

test.describe("My Work completed window", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.coordinator@pulseos.local");
  });

  test("live buckets have no period control; Completed shows one defaulting to 7 days", async ({ page }) => {
    await page.goto("/my-work?tab=today");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await expect(page.getByTestId("my-work-completed-range")).toHaveCount(0);

    await page.getByTestId("my-work-tab-completed").click();
    await expectPeriod(page, "my-work-completed", "7d");
  });

  test("the chosen window is asked of the API, kept in the URL and survives a refresh", async ({ page }) => {
    await page.goto("/my-work?tab=completed");
    const days = (u: string) => {
      const q = new URL(u).searchParams;
      return (Date.parse(`${q.get("completedTo")}T00:00:00Z`) - Date.parse(`${q.get("completedFrom")}T00:00:00Z`)) / 86_400_000 + 1;
    };
    // The initial load asks for 7 days; choosing 30 must produce a request that asks for exactly 30.
    const request = page.waitForRequest((r) => r.url().includes("/tasks?") && r.url().includes("view=completed") && days(r.url()) === 30);
    await pickPeriod(page, "my-work-completed", "30d");
    expect(days((await request).url())).toBe(30);
    await expect(page).toHaveURL(/crange=30d/);
    await page.reload();
    await expectPeriod(page, "my-work-completed", "30d");
  });
});

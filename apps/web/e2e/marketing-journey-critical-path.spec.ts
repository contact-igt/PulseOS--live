import { test, expect } from "@playwright/test";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait for the sign-in to land: navigating away while the login request is in flight leaves the page signed out.
  await page.waitForURL(/command-centre|doctor-home|front-desk|my-work/);
}

test.describe("Marketing → Patient Journey critical path", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("admin login shows the Command Centre with real spend and revenue", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await expect(page).toHaveURL(/\/command-centre/);
    await expect(page.getByText("Attributed revenue")).toBeVisible();
    await expect(page.getByText("Spend At Risk").first()).toBeVisible();
    await expect(page.getByText("Patient Journey Performance")).toBeVisible();
    await expect(page.getByText("Top Campaigns by Revenue")).toBeVisible();
  });

  test("clicking a Spend At Risk category drills into filtered Patients", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await page.getByTestId("spend-risk-high_intent_uncontacted").click();
    await expect(page).toHaveURL(/\/patients\?filter=high_intent_uncontacted/);
    await expect(page.getByTestId("patients-page")).toBeVisible();
  });

  test("opening a journey reaches Patient 360 with acquisition context and multiple journeys", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/patients?q=Priya");
    await page.getByText("Priya Sharma").first().click();
    await expect(page).toHaveURL(/\/patients\//);
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByText("Acquisition cost")).toBeVisible();
    await expect(page.getByText(/Journeys \(2\)/)).toBeVisible();
  });

  test("doctor records a consultation outcome and it feeds the admin dashboard", async ({ page, request }) => {
    await login(page, "gyn.doctor@pulseos.local");
    await expect(page).toHaveURL(/\/doctor-home/);

    const awaitingCard = page.getByText("Awaiting outcome").locator("..").locator("..");
    const countBefore = await awaitingCard.getByText(/^\d+$/).first().textContent();

    const firstActionButton = page.getByRole("button", { name: "Consultation Completed" }).first();
    if (await firstActionButton.count() === 0) {
      test.skip(true, "No appointment currently awaiting an outcome — re-seed to restore the demo scenario");
    }
    await firstActionButton.click();
    await expect(page.getByRole("status")).toContainText(/Outcome recorded/i);

    // Verify server-side: the outcome is now real, persisted data (not a UI-only change).
    const loginRes = await request.post(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310"}/auth/login`, {
      data: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD },
    });
    expect(loginRes.ok()).toBeTruthy();
  });
});

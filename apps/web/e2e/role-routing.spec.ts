import { test, expect } from "@playwright/test";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("Role home routing", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("Hospital Admin lands on Command Centre", async ({ page }) => {
    await login(page, "gyn.admin@pulseos.local");
    await expect(page).toHaveURL(/\/command-centre/);
    await expect(page.getByTestId("command-centre")).toBeVisible();
  });

  test("Front Desk lands on Front Desk, not Command Centre", async ({ page }) => {
    await login(page, "gyn.frontdesk@pulseos.local");
    await expect(page).toHaveURL(/\/front-desk/);
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
  });

  test("Patient Coordinator lands on My Work, not Command Centre", async ({ page }) => {
    await login(page, "gyn.coordinator@pulseos.local");
    await expect(page).toHaveURL(/\/my-work/);
    await expect(page.getByTestId("my-work-page")).toBeVisible();
  });

  test("Doctor lands on Doctor Command Centre", async ({ page }) => {
    await login(page, "gyn.doctor@pulseos.local");
    await expect(page).toHaveURL(/\/doctor-home/);
    await expect(page.getByTestId("doctor-home")).toBeVisible();
  });

  test("the old /treatment URL redirects to the canonical /treatments route", async ({ page }) => {
    await login(page, "gyn.coordinator@pulseos.local");
    await page.waitForURL(/\/my-work/); // sign-in must finish before navigating away, or the session cookie races the redirect
    await page.goto("/treatment");
    await expect(page).toHaveURL(/\/treatments$/);
    await expect(page.getByTestId("treatments-page")).toBeVisible();
  });
});

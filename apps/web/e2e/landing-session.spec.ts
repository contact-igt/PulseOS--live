import { test, expect, type Page } from "@playwright/test";

// Landing page at "/", and how a session moves people between it, sign-in and the app: real server sessions end to end.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ADMIN = "gyn.admin@pulseos.local";

async function signIn(page: Page) {
  await page.getByLabel("Email address").fill(ADMIN);
  await page.locator("#password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.describe("landing page and session flow", () => {
  test("a visitor lands on the landing page, not on sign-in, and Sign in leads to the login page", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
    await page.waitForURL(/\/login$/);
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test.describe("with an account", () => {
    test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

    test("landing → Sign in → app; a deep link while signed out returns after sign-in; signed-in people skip the login page; logout ends the session", async ({ page }) => {
      // Landing → Sign in → continues into the normal flow.
      await page.goto("/");
      await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
      await page.waitForURL(/\/login$/);
      await signIn(page);
      await page.waitForURL(/\/command-centre/);

      // Signed in: the login page does not show the form again, it goes straight back in.
      await page.goto("/login");
      await page.waitForURL(/\/command-centre/);

      // Log out, then open a deep link: sign-in remembers where they were going.
      await page.getByTestId("profile-menu-trigger").click();
      await page.getByTestId("logout-button").click();
      await page.waitForURL(/\/login(\/[a-z0-9-]+)?$/);
      await page.goto("/patients");
      await page.waitForURL(/\/login(\/[a-z0-9-]+)?\?from=%2Fpatients$/);
      await signIn(page);
      await page.waitForURL(/\/patients$/);
    });

    test("a hostile ?from= is ignored", async ({ page }) => {
      await page.goto("/login?from=https%3A%2F%2Fevil.example%2F");
      await signIn(page);
      await page.waitForURL(/\/command-centre/);
      expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL ?? "http://localhost:3310").origin);
    });

    test("an expired session returns the person to sign-in with the page they were on", async ({ page, context }) => {
      await page.goto("/login");
      await signIn(page);
      await page.waitForURL(/\/command-centre/);
      await page.goto("/patients");
      await expect(page).toHaveURL(/\/patients$/);
      // The session expires server-side / is ended in another tab: the browser's cookie goes away.
      await context.clearCookies();
      await page.reload();
      await page.waitForURL(/\/login(\/[a-z0-9-]+)?\?from=%2Fpatients$/, { timeout: 15_000 });
    });
  });
});

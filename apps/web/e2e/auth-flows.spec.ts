import { test, expect, type Page } from "@playwright/test";

// Live auth acceptance: real server sessions end to end, with no console
// errors, no failing auth request and no Next.js error overlay at any step.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    // Chrome logs every 4xx fetch as a console error. The one expected 401 is
    // the session probe on a protected page after logout — that is how the
    // app detects "signed out" (the redirect is asserted separately; any
    // other auth 4xx/5xx is still caught by the response listener below).
    if (msg.type() === "error" && !/Failed to load resource: .*\b401\b/.test(msg.text())) problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.url().includes("/auth/") && res.status() >= 400 && !res.url().endsWith("/auth/session")) {
      problems.push(`${res.request().method()} ${res.url()} -> ${res.status()}`);
    }
  });
  return problems;
}

// In dev, Next always mounts a portal for its dev-tools button; a runtime
// error shows as an issues badge / error dialog (and as a pageerror above).
async function expectNoOverlay(page: Page) {
  await expect(page.getByRole("button", { name: /issue/i })).toHaveCount(0);
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
}

async function logout(page: Page) {
  await page.getByTestId("profile-menu-trigger").click();
  await page.getByTestId("logout-button").click();
  // A hospital with its own sign-in page (every seeded demo has one) sends its people back to THAT page; others to /login.
  await page.waitForURL(/\/login(\/[a-z0-9-]+)?$/);
}

test.describe("auth flows (live)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("Developer Login → Ophthalmology admin → refresh keeps session → logout → protected route bounces to login", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await page.getByTestId("dev-login-env-ophthalmology").click();
    await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
    await page.waitForURL(/\/command-centre/);
    await expect(page.getByTestId("command-centre")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("command-centre")).toBeVisible();

    await logout(page);
    await page.goto("/command-centre");
    await page.waitForURL(/\/login/);
    await expectNoOverlay(page);
    expect(problems).toEqual([]);
  });

  test("manual email/password login → protected page → logout", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/login");
    await page.getByLabel("Email address").fill("eye.coordinator@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/my-work/);
    await expect(page.getByTestId("my-work-page")).toBeVisible();

    await logout(page);
    await expectNoOverlay(page);
    expect(problems).toEqual([]);
  });

  test("wrong password keeps the email, shows a clear error and focuses the password — no overlay", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill("eye.coordinator@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByTestId("login-form").getByRole("alert")).toHaveText("Incorrect email or password.");
    await expect(page.getByLabel("Email address")).toHaveValue("eye.coordinator@pulseos.local");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await expectNoOverlay(page);
  });

  test("Doctor Developer Login → Doctor Home → logout", async ({ page }) => {
    const problems = watch(page);
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await page.getByTestId("dev-login-env-ophthalmology").click();
    await page.getByTestId("dev-login-role-DOCTOR").click();
    await page.waitForURL(/\/doctor-home/);

    await logout(page);
    await page.goto("/doctor-home");
    await page.waitForURL(/\/login/);
    await expectNoOverlay(page);
    expect(problems).toEqual([]);
  });
});

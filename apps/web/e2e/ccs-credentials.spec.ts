import { test, expect, type Page } from "@playwright/test";

// CCS IVR > Credentials, against a LOCAL stack on a disposable database (never production). Synthetic keys only.
// Covers: first save, partial update, reload persistence, no raw secret in any response, safe messages on failure,
// and the separate inbound-webhook status facts.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const KEYS = { apiKey: "synthetic-e2e-api-key-7c1d", secretKey: "synthetic-e2e-secret-key-93be", integrationKey: "synthetic-e2e-integration-key-5a0f" };
const NEEDLES = Object.values(KEYS);

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home|leads/);
}

async function openCredentials(page: Page) {
  await page.goto("/integrations?open=ccs_ivr");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("detail-tab-credentials").click();
  return sheet;
}

test.describe("CCS IVR credentials", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");
  test.describe.configure({ mode: "serial" });

  test("first save, partial update, reload: saved state persists and no raw secret ever reaches the browser", async ({ page }) => {
    const bodies: string[] = [];
    page.on("response", async (r) => {
      if (r.url().startsWith(API) && /integrations/.test(r.url())) bodies.push(await r.text().catch(() => ""));
    });
    await login(page, "eyev1.superadmin@pulseos.local");
    let sheet = await openCredentials(page);

    // (The pristine "Not set" state is covered by the component tests; this spec must also be repeatable on a used database.)
    await sheet.getByTestId("secret-apiKey").fill(KEYS.apiKey);
    await sheet.getByTestId("secret-secretKey").fill(KEYS.secretKey);
    await sheet.getByTestId("secret-integrationKey").fill(KEYS.integrationKey);
    await sheet.getByTestId("save-credentials").click();
    await expect(sheet.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(sheet.getByText("Secret saved")).toHaveCount(3);
    // The fields are cleared after a save: nothing to resubmit, nothing shown.
    await expect(sheet.getByTestId("secret-apiKey")).toHaveValue("");

    // Partial update: only the secret key; the other two stay saved.
    await sheet.getByTestId("secret-secretKey").fill("synthetic-e2e-secret-key-UPDATED");
    await sheet.getByTestId("save-credentials").click();
    await expect(sheet.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(sheet.getByText("Secret saved")).toHaveCount(3);

    // Reload: still saved, still masked.
    await page.reload();
    sheet = await openCredentials(page);
    await expect(sheet.getByText("Secret saved")).toHaveCount(3);
    await expect(sheet.getByTestId("secret-apiKey")).toHaveValue("");

    // Overview: inbound facts are separate and truthful (a key is saved; no call report has arrived).
    await sheet.getByTestId("detail-tab-overview").click();
    await expect(sheet.getByTestId("inbound-webhook")).toHaveText("Ready");
    await expect(sheet.getByTestId("inbound-credentials")).toHaveText("Saved");

    for (const body of bodies) for (const needle of [...NEEDLES, "synthetic-e2e-secret-key-UPDATED"]) expect(body).not.toContain(needle);
  });

  test("a failed save keeps what was typed and shows a safe message, never the raw error code", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    const sheet = await openCredentials(page);
    for (const [status, error, expected] of [
      [503, "encryption_not_configured", /secure credential storage isn.t set up/i],
      [500, "internal_error", /credentials could not be saved/i],
    ] as const) {
      await page.route("**/integrations/hub/ccs_ivr/configuration", (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error }) }));
      await sheet.getByTestId("secret-apiKey").fill("synthetic-e2e-typed-value");
      await sheet.getByTestId("save-credentials").click();
      const msg = sheet.getByRole("status").filter({ hasText: expected });
      await expect(msg).toBeVisible();
      await expect(msg).not.toContainText(/internal_error|encryption_not_configured/);
      await expect(sheet.getByTestId("secret-apiKey")).toHaveValue("synthetic-e2e-typed-value");
      await page.unroute("**/integrations/hub/ccs_ivr/configuration");
    }
  });
});

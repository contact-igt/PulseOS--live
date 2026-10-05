import { test, expect, type Page } from "@playwright/test";
import path from "path";

// Screenshot package for the final enterprise visual system + data
// visualization pass: My Work overdue urgency cue, Settings permission gate,
// success Badge tone rollout, Command Centre Attention/SLA severity-cue
// redesign, Patient 360 journey mini-flow, Timeline day grouping, and
// Global Search stage/highlighting — extends review-artifacts/brain-review.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/brain-review");

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Session 4 final visual pass screenshots", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("captures overdue cues, permission gating, success tones, mini-flow, and search polish", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // My Work — Overdue tab: left accent + tinted row + "Xd overdue" text,
    // the strongest semantic cue, no longer conflated with the type badge.
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/my-work");
    await page.getByTestId("my-work-tab-overdue").click();
    await expect(page.getByTestId("my-work-task-list")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "33-my-work-overdue.png") });

    // Settings — read-only for a role without MANAGE_SPECIALTIES: no dead
    // Edit/Disable controls, no "Could not load this specialty" error.
    await page.goto("/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "34-settings-readonly-coordinator.png") });

    // Treatments — success (teal) badge for Completed, distinct from the
    // amber/blue in-progress states.
    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "35-treatments-success-tone.png") });

    // Command Centre — Attention/SLA severity-dot redesign + success-toned
    // KPI/status where applicable.
    await page.goto("/command-centre");
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/command-centre");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "36-command-centre-attention-redesign.png") });

    // Settings — Hospital Admin, expanded specialty editor (Edit).
    await page.goto("/settings");
    await page.getByTestId("specialty-toggle-GYNECOLOGY").waitFor();
    await page.getByText("Edit").first().click();
    await expect(page.getByTestId("specialty-display-label")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "37-settings-expanded-specialty.png") });

    // Integrations — success (teal) "Connected" badges, distinct from the
    // neutral "Fixture" tag and gray "Not configured".
    await page.goto("/integrations?view=connectors");
    await expect(page.getByText("Connectors")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "38-integrations-success-tone.png") });

    // Patient 360 — compact journey mini-flow stepper (not another funnel),
    // and Timeline day-grouping (Today/date headers).
    await page.goto("/patients");
    await page.getByText("Priya Sharma", { exact: true }).first().click();
    await expect(page).toHaveURL(/\/patients\/[^/]+$/);
    await expect(page.getByText(/\d+ events?$/)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "39-patient360-mini-flow.png") });

    // Global search — match highlighting + current stage shown.
    await page.goto("/command-centre");
    await page.getByTestId("global-patient-search").fill("pri");
    await expect(page.getByTestId("global-patient-search-results")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "40-global-search-highlight-stage.png") });
    await page.keyboard.press("Escape");
  });
});

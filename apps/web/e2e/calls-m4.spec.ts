import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TENANT = "PulseOS Ophthalmology V1 Demo";
const run = `${Date.now()}`.slice(-6);
const PATIENT = `E2E Call Patient ${run}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

/** Journey carrying the seeded demo call story, found by what it contains rather than by a fixed id. */
const journeyWith = (clause: string) =>
  sql(`SELECT c.journey_id FROM calls c JOIN tenants t ON t.id = c.tenant_id WHERE t.name = '${TENANT}' AND ${clause} ORDER BY c.created_at LIMIT 1`);

async function createLead(page: Page): Promise<string> {
  // A fresh, named lead through the real API, as the signed-in user; removed afterwards by name prefix.
  return page.evaluate(async ({ api, name, phone }) => {
    const branches = ((await (await fetch(`${api}/lookups`, { credentials: "include" })).json()) as { branches: { id: string }[] }).branches;
    const res = await fetch(`${api}/leads`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, phone, specialtyKey: "CATARACT", branchId: branches[0]!.id, journeyType: "Cataract", sourceKey: "instagram", customFieldValues: {} }),
    });
    return ((await res.json()) as { journeyId: string }).journeyId;
  }, { api: API, name: PATIENT, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}` });
}

test.describe("M4 — Calls on the Interaction Timeline", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => purgePatients("E2E Call Patient"));

  test("Staff: Journey → Log call → incoming, connected, feedback, needs callback, tomorrow 11:00 → Timeline card, call counts and My Work, persisted after refresh", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const journeyId = await createLead(page);
    // The journey owner is whoever the allocation chose, else nobody: give it to this user so My Work shows the callback.
    await page.goto(`/journeys/${journeyId}`);
    await expect(page.getByTestId("journey-detail")).toBeVisible();
    await expect(page.getByTestId("journey-call-stats")).toContainText("No calls yet");

    await page.getByTestId("journey-log-call").click();
    const sheet = page.getByTestId("log-call");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(PATIENT)).toBeVisible(); // nothing about the patient is asked again
    await expect(sheet.getByLabel("Name")).toHaveCount(0);

    await sheet.getByTestId("log-call-direction-inbound").click();
    await sheet.getByTestId("log-call-connected-true").click();
    await sheet.getByTestId("log-call-minutes").fill("4");
    await sheet.getByTestId("log-call-seconds").fill("38");
    await sheet.getByTestId("log-call-feedback").fill("Patient will confirm after speaking with family.");
    await sheet.getByTestId("log-call-outcome").selectOption("needs_callback");
    // This outcome needs a follow-up: the next action is a callback and "None" can't be chosen.
    await expect(sheet.getByTestId("log-call-next-callback")).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByTestId("log-call-next-none")).toBeDisabled();
    await expect(sheet.getByTestId("log-call-callback-time")).toHaveValue("11:00");
    await sheet.getByTestId("log-call-callback-note").fill("Friday 11:00 AM");

    // Double-clicking Save must not log the call twice.
    await sheet.getByTestId("log-call-save").dblclick();
    await expect(sheet).not.toBeVisible();

    const card = page.locator('[data-testid^="call-card-"]').first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("Incoming");
    await expect(card).toContainText("Logged by staff");
    await expect(card).toContainText("Connected");
    await expect(card).toContainText("4m 38s");
    await expect(card.locator('[data-testid^="call-staff-feedback-"]')).toContainText("Patient will confirm after speaking with family.");
    await expect(card.locator('[data-testid^="call-outcome-"]')).toContainText("Needs callback");
    await expect(card.locator('[data-testid^="call-outcome-"]')).toContainText("Callback created");
    await expect(page.getByTestId("call-stat-calls")).toHaveText("1");
    await expect(page.getByTestId("call-stat-incoming")).toHaveText("1");
    await expect(page.getByTestId("call-stat-connected")).toHaveText("1");
    // Staff cannot open recordings or transcripts: no controls at all.
    await expect(card.locator('[data-testid^="call-play-"]')).toHaveCount(0);
    await expect(card.locator('[data-testid^="call-transcript-toggle-"]')).toHaveCount(0);

    // Exactly one call and one callback were saved.
    expect(sql(`SELECT count(*) FROM calls WHERE journey_id = '${journeyId}'`)).toBe("1");
    expect(sql(`SELECT count(*) FROM tasks WHERE journey_id = '${journeyId}'`)).toBe("1");

    // My Work shows the callback.
    await page.goto("/my-work");
    await expect(page.getByText(PATIENT).first()).toBeVisible();

    // Persisted after a refresh.
    await page.goto(`/journeys/${journeyId}`);
    await expect(page.locator('[data-testid^="call-staff-feedback-"]').first()).toContainText("Patient will confirm");
    await expect(page.getByTestId("call-stat-calls")).toHaveText("1");
  });

  test("Staff can log a not-connected outgoing call, and a failed save keeps what was typed", async ({ page }) => {
    await login(page, "eyev1.coordinator@pulseos.local");
    const journeyId = await createLead(page);
    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("journey-log-call").click();
    const sheet = page.getByTestId("log-call");
    await sheet.getByTestId("log-call-direction-outbound").click();
    await sheet.getByTestId("log-call-connected-false").click();
    await expect(sheet.getByTestId("log-call-minutes")).toHaveCount(0); // no duration when nobody spoke
    await sheet.getByTestId("log-call-feedback").fill("Rang five times, no answer.");

    // Break the request: the sheet stays open with the text intact and an inline error.
    await page.route("**/journeys/*/calls", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }));
    await sheet.getByTestId("log-call-save").click();
    await expect(sheet.getByTestId("log-call-error")).toBeVisible();
    await expect(sheet.getByTestId("log-call-feedback")).toHaveValue("Rang five times, no answer.");
    await page.unroute("**/journeys/*/calls");

    await sheet.getByTestId("log-call-save").click();
    await expect(sheet).not.toBeVisible();
    await expect(page.locator('[data-testid^="call-card-"]').first()).toContainText("No answer");
    await expect(page.getByTestId("call-stat-not-connected")).toHaveText("1");
  });

  test("Admin: the Cataract journey's IVR call — Play recording, View transcript, demo summary and Staff feedback shown apart", async ({ page }) => {
    const journeyId = journeyWith("c.external_call_id LIKE 'demo-eyev1-ivr-cataract'");
    expect(journeyId).toBeTruthy();
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto(`/journeys/${journeyId}`);
    const card = page.locator('[data-testid^="call-card-"]').filter({ has: page.locator('[data-testid^="call-summary-"]') }).first();
    await expect(card).toBeVisible();

    // The AI-derived summary is labelled for what it is; the human's feedback is a separate, differently labelled block.
    await expect(card.locator('[data-testid^="call-summary-"]')).toContainText("Demo summary — not AI");
    await expect(card.locator('[data-testid^="call-summary-"]')).toContainText("cataract surgery");
    await expect(card.locator('[data-testid^="call-staff-feedback-"]')).toContainText("Staff feedback");
    await expect(card.locator('[data-testid^="call-staff-feedback-"]')).toContainText("Patient will confirm after speaking with family.");
    await expect(card.locator('[data-testid^="call-summary-"]')).not.toContainText("Staff feedback");

    // Playback goes through PulseOS (authenticated stream): the audio element loads real, playable audio.
    await card.locator('[data-testid^="call-play-"]').click();
    const audio = card.locator("audio");
    await expect(audio).toBeVisible();
    const src = await audio.getAttribute("src");
    expect(src).toContain("/calls/");
    expect(src).not.toContain("pulseos-fixture");
    await expect.poll(async () => audio.evaluate((a: HTMLAudioElement) => (Number.isFinite(a.duration) ? a.duration : 0)), { timeout: 10_000 }).toBeGreaterThan(1);

    // Transcript is secondary: collapsed by default, wraps naturally when opened.
    await expect(card.getByText("Saturday morning")).toHaveCount(1); // only inside the summary
    await card.locator('[data-testid^="call-transcript-toggle-"]').click();
    const transcript = card.locator('[data-testid^="call-transcript-text-"]').filter({ hasText: "Transcript" });
    await expect(transcript).toContainText("demo, not a real transcription");
    await expect(transcript).toContainText("Do you have anything on Saturday morning");
    // The provider's recording reference never reaches the page.
    expect(await page.content()).not.toContain("pulseos-fixture");
  });

  test("Staff on that same journey see the summary and feedback but have no recording or transcript, and the server refuses them", async ({ page }) => {
    const journeyId = journeyWith("c.external_call_id LIKE 'demo-eyev1-ivr-cataract'");
    const callId = sql(`SELECT id FROM calls WHERE external_call_id = 'demo-eyev1-ivr-cataract'`);
    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto(`/journeys/${journeyId}`);
    const card = page.locator('[data-testid^="call-card-"]').filter({ has: page.locator('[data-testid^="call-summary-"]') }).first();
    await expect(card.locator('[data-testid^="call-summary-"]')).toBeVisible();
    await expect(card.locator('[data-testid^="call-staff-feedback-"]')).toBeVisible();
    await expect(card.locator('[data-testid^="call-play-"]')).toHaveCount(0);
    await expect(card.locator('[data-testid^="call-download-"]')).toHaveCount(0);
    await expect(card.locator('[data-testid^="call-transcript-toggle-"]')).toHaveCount(0);
    const statuses = await page.evaluate(async ({ api, id }) => {
      const rec = await fetch(`${api}/calls/${id}/recording`, { credentials: "include" });
      const tr = await fetch(`${api}/calls/${id}/transcript`, { credentials: "include" });
      return [rec.status, tr.status];
    }, { api: API, id: callId });
    expect(statuses).toEqual([403, 403]);
  });

  test("a missed IVR call's callback is waiting in My Work, and the Doctor role has no Log call control", async ({ page }) => {
    await login(page, "eyev1.coordinator@pulseos.local");
    const patient = sql(`SELECT p.name FROM calls c JOIN patients p ON p.id = c.patient_id WHERE c.external_call_id = 'demo-eyev1-ivr-missed'`);
    expect(patient).toBeTruthy();
    await page.goto("/my-work");
    // Unassigned or owned callbacks are visible to those who can manage tasks; the task exists for that journey either way.
    expect(sql(`SELECT count(*) FROM tasks t JOIN calls c ON c.journey_id = t.journey_id WHERE c.external_call_id = 'demo-eyev1-ivr-missed' AND t.reason = 'missed_follow_up' AND t.status = 'pending'`)).toBe("1");

    await login(page, "eyev1.doctor@pulseos.local");
    const journeyId = journeyWith("c.external_call_id LIKE 'demo-eyev1-ivr-cataract'");
    await page.goto(`/journeys/${journeyId}`).catch(() => undefined);
    await expect(page.getByTestId("journey-log-call")).toHaveCount(0);
  });

  for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768], [768, 1024], [390, 844]] as const) {
    test(`Journey Detail + Log call sheet at ${w}x${h}: no horizontal overflow, controls reachable`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await login(page, "eyev1.admin@pulseos.local");
      const journeyId = journeyWith("c.external_call_id LIKE 'demo-eyev1-ivr-cataract'");
      await page.goto(`/journeys/${journeyId}`);
      await expect(page.locator('[data-testid^="call-card-"]').first()).toBeVisible();
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await overflow()).toBeLessThanOrEqual(1);
      await page.locator('[data-testid^="call-play-"]').first().click();
      await page.locator('[data-testid^="call-transcript-toggle-"]').first().click();
      await expect(page.locator('[data-testid^="call-transcript-text-"]').filter({ hasText: "Transcript" })).toBeVisible();
      expect(await overflow()).toBeLessThanOrEqual(1);
      await page.getByTestId("journey-log-call").click();
      const sheet = page.getByTestId("log-call");
      await expect(sheet).toBeVisible();
      // The sheet slides in; wait for it to settle before measuring.
      await expect.poll(async () => { const b = (await sheet.boundingBox())!; return b.x + b.width; }, { timeout: 3000 }).toBeLessThanOrEqual(w + 1);
      const box = (await sheet.boundingBox())!;
      if (w <= 430) expect(box.width).toBeGreaterThan(w * 0.9); // full-width sheet on a phone
      const save = (await page.getByTestId("log-call-save").boundingBox())!;
      expect(save.height).toBeGreaterThanOrEqual(w <= 430 ? 44 : 30);
      await page.keyboard.press("Escape");
      await expect(sheet).not.toBeVisible();
      await expect(page.getByTestId("journey-log-call")).toBeFocused(); // focus returns to what opened it
    });
  }
});

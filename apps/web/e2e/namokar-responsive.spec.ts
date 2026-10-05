import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// The pilot's screens at the five widths the hospital will actually use: no horizontal page scroll, controls reachable, the
// date/select controls are PulseOS's own (not the browser's black native pickers), and the breadcrumb and the three journey
// actions stay usable. Screenshots are written for the visual check (apps/web/test-results/namokar-screens, not committed).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const SHOTS = process.env.NAMOKAR_SHOTS === "1";
const WIDTHS = [
  { label: "1440", width: 1440, height: 900 },
  { label: "1280", width: 1280, height: 800 },
  { label: "1024", width: 1024, height: 768 },
  { label: "768", width: 768, height: 1024 },
  { label: "390", width: 390, height: 844 },
];

async function login(page: Page, who: string) {
  await page.goto("/login/namokar-v1");
  await page.getByLabel("Email address").fill(`namokar.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const flagshipId = () => sql(`SELECT j.id FROM journeys j JOIN tenants t ON t.id = j.tenant_id WHERE t.name = 'Namokar Eye & Oculoplasty Centre' AND j.journey_type = 'Cataract' AND j.source = 'google' AND j.stage = 'scheduled' LIMIT 1`);

test.describe("Namokar pilot: responsive", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => purgePatients("E2E NPILOT "));

  for (const w of WIDTHS) {
    test(`owner: Performance, Leads, Journey, Patient at ${w.label}`, async ({ page }) => {
      await page.setViewportSize({ width: w.width, height: w.height });
      await login(page, "superadmin");
      const id = flagshipId();
      const pages: [string, string][] = [
        ["performance", "/command-centre?cc=performance"],
        ["overview", "/command-centre?cc=overview"],
        ["leads", "/leads"],
        ["journey", `/journeys/${id}?from=leads`],
      ];
      for (const [name, path] of pages) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        expect(await overflow(page), `${name} overflows at ${w.label}`).toBeLessThanOrEqual(0);
        if (SHOTS) await page.screenshot({ path: `test-results/namokar-screens/owner-${name}-${w.label}.png`, fullPage: false });
      }
      // The journey's three primary actions and the breadcrumb are on screen and tappable.
      for (const t of ["journey-log-call", "journey-add-followup", "journey-book-appointment"]) await expect(page.getByTestId(t)).toBeVisible();
      await expect(page.getByTestId("breadcrumb")).toBeVisible();
      if (w.width <= 1023) {
        const box = await page.getByTestId("journey-log-call").boundingBox();
        expect(box!.height, "tap target").toBeGreaterThanOrEqual(40);
      }
      // Performance: the filter controls are PulseOS's own, not native black pickers.
      await page.goto("/command-centre?cc=performance");
      await expect(page.getByTestId("performance-view")).toBeVisible();
      await expect(page.locator('input[type="date"]:visible')).toHaveCount(0);
    });

    test(`front desk and doctor at ${w.label}`, async ({ page, browser }) => {
      await page.setViewportSize({ width: w.width, height: w.height });
      await login(page, "frontdesk");
      for (const [name, path] of [["front-desk", "/front-desk"], ["appointments", "/appointments"], ["leads", "/leads"]]) {
        await page.goto(path!);
        await page.waitForLoadState("networkidle");
        expect(await overflow(page), `${name} overflows at ${w.label}`).toBeLessThanOrEqual(0);
        if (SHOTS) await page.screenshot({ path: `test-results/namokar-screens/frontdesk-${name}-${w.label}.png` });
      }
      const doc = await browser.newContext({ viewport: { width: w.width, height: w.height } });
      const dp = await doc.newPage();
      await login(dp, "doctor");
      await dp.goto("/doctor-home");
      await dp.waitForLoadState("networkidle");
      expect(await overflow(dp), `doctor-home overflows at ${w.label}`).toBeLessThanOrEqual(0);
      if (SHOTS) await dp.screenshot({ path: `test-results/namokar-screens/doctor-home-${w.label}.png` });
      await doc.close();
    });
  }

  test("390: the Namokar sign-in page fits and its fields are tappable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login/namokar-v1");
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const l of ["Email address"]) expect((await page.getByLabel(l).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: "test-results/namokar-screens/login-390.png" });
  });
});

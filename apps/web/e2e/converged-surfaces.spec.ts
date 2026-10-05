import { expect, test, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// The workflow screens (Add Lead, Log Call with the inline appointment, CRM Fields, Clinic Hours, Doctor Planner) under every
// interface style (Settings > Appearance): forms stay readable (near-solid panels, solid footers) even in Airy, nothing scrolls
// sideways, and the Settings tab strip never clips its labels on a phone. V2 is put back to its default style afterwards.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const MARKER = "QA V2 ";
const STYLES = ["airy", "balanced", "solid"] as const;
const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
];

async function login(page: Page) {
  await page.goto("/login/namokar-v2");
  await page.getByLabel("Email address").fill("namokarv2.superadmin@pulseos.local");
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
const alpha = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor)!;
    const parts = m[1]!.split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("converged: workflow screens under every interface style", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  const cleanV2 = () => {
    sql(`UPDATE tenants SET surface_style = NULL WHERE login_slug = 'namokar-v2'`);
    purgePatients(MARKER);
    sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`);
  };
  test.beforeAll(cleanV2);
  test.afterAll(cleanV2);

  for (const style of STYLES) {
    for (const size of SIZES) {
      test(`${style} · ${size.name}px: forms stay readable and fit`, async ({ browser }) => {
        sql(`UPDATE tenants SET surface_style = '${style}' WHERE login_slug = 'namokar-v2'`);
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await login(page);
        await expect.poll(() => page.evaluate(() => document.documentElement.dataset.surface)).toBe(style);
        const shot = async (name: string) => { await page.waitForTimeout(350); /* let the 200ms drawer animation finish */ await page.screenshot({ path: `review-artifacts/converged-${style}-${size.name}-${name}.png` }); };

        // Add Lead (placed fields) - a content panel.
        await page.goto("/leads");
        await page.getByRole("button", { name: /add lead/i }).first().click();
        await expect(page.getByTestId("lead-phone-input")).toBeVisible();
        expect(await alpha(page, ".drawer-panel"), "Add Lead panel").toBeGreaterThanOrEqual(0.9);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await shot("add-lead");
        await page.keyboard.press("Escape");

        // Log Call with the inline appointment, on a real marker-named journey.
        const lead = await page.evaluate(
          async ({ api, marker }) => {
            const lk = await (await fetch(`${api}/lookups`, { credentials: "include" })).json();
            const res = await fetch(`${api}/leads`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${marker}Converged ${Math.random().toString(36).slice(2, 6)}`, phone: `+9190000${String(Math.floor(10000 + Math.random() * 89999))}`, specialtyKey: "CATARACT", branchId: lk.branches[0].id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} }) });
            return res.json();
          },
          { api: API, marker: MARKER },
        );
        await page.goto(`/journeys/${lead.journeyId}`);
        await page.getByRole("button", { name: "Log call" }).first().click();
        const sheet = page.getByTestId("log-call");
        await sheet.getByTestId("log-call-next-appointment").click();
        await expect(sheet.getByTestId("log-call-appt-time")).toBeVisible();
        expect(await alpha(page, ".drawer-panel"), "Log Call panel").toBeGreaterThanOrEqual(0.9);
        expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth), "Log Call drawer").toBeLessThanOrEqual(0);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await shot("log-call");
        await page.keyboard.press("Escape");

        for (const [path, ready, name] of [
          ["/settings?section=fields", "crm-fields-section", "crm-fields"],
          ["/settings?section=hours", "clinic-hours-section", "clinic-hours"],
          ["/settings?section=appearance", "settings-page", "appearance"],
          ["/appointments?view=doctors", "doctor-schedule-view", "doctor-planner"],
        ] as const) {
          await page.goto(path);
          await expect(page.getByTestId(ready)).toBeVisible();
          expect(await overflow(page), name).toBeLessThanOrEqual(0);
          await shot(name);
        }

        // The Settings tab strip: every label fully shown or reachable by scrolling - never cut mid-word.
        await page.goto("/settings");
        const tabs = page.getByRole("tablist", { name: "Settings sections" });
        await expect(tabs).toBeVisible();
        const clipped = await tabs.getByRole("tab").evaluateAll((els) => els.filter((t) => t.scrollWidth > t.clientWidth + 1).map((t) => t.textContent));
        expect(clipped, "tab labels cut off").toEqual([]);

        expect(errors, "page errors").toEqual([]);
        await context.close();
      });
    }
  }
});

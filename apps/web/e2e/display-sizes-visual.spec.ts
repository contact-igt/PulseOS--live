import { expect, test, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// The key screens at the three readability combinations people will actually use, at desktop, tablet and phone: nothing scrolls
// sideways, nothing throws, the Add Lead / Log call drawers keep their action buttons on screen. Screenshots go to review-artifacts.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const MARKER = "QA V2 ";
const COMBOS = [
  { name: "default", interfaceSize: "comfortable", textSize: "default" },
  { name: "large-large", interfaceSize: "large", textSize: "large" },
  { name: "compact-large", interfaceSize: "compact", textSize: "large" },
] as const;
const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
];
const PAGES: [string, string][] = [
  ["/command-centre?tab=performance", "performance-view"],
  ["/leads", "leads-search"],
  ["/my-work", "profile-menu-trigger"],
  ["/front-desk", "front-desk-page"],
  ["/appointments?view=doctors", "doctor-schedule-view"],
  ["/settings?section=fields", "crm-fields-section"],
  ["/settings?section=hours", "clinic-hours-section"],
  ["/settings?section=appearance", "appearance-section"],
];

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const cleanV2 = () => {
  purgePatients(MARKER);
  sql(`UPDATE users SET interface_size = NULL, text_size = NULL WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`);
  sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`);
};

test.describe("display sizes: key screens stay usable", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(cleanV2);
  test.afterAll(cleanV2);

  for (const combo of COMBOS) {
    for (const size of SIZES) {
      test(`${combo.name} · ${size.name}px`, async ({ browser }) => {
        test.setTimeout(120_000);
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto("/login/namokar-v2");
          await page.getByLabel("Email address").fill("namokarv2.superadmin@pulseos.local");
          await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
          await page.getByRole("button", { name: "Sign in" }).click();
          await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
          expect(await page.evaluate(async ({ api, body }) => (await fetch(`${api}/me/preferences`, { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { api: API, body: { interfaceSize: combo.interfaceSize, textSize: combo.textSize } })).toBe(200);
          const shot = async (name: string) => {
            await page.waitForTimeout(300);
            await page.screenshot({ path: `review-artifacts/display-${combo.name}-${size.name}-${name}.png` });
          };

          const lead = await page.evaluate(
            async ({ api, marker }) => {
              const lk = await (await fetch(`${api}/lookups`, { credentials: "include" })).json();
              const res = await fetch(`${api}/leads`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${marker}Sizes ${Math.random().toString(36).slice(2, 6)}`, phone: `+9190000${Math.floor(10000 + Math.random() * 89999)}`, specialtyKey: "CATARACT", branchId: lk.branches[0].id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} }) });
              return res.json();
            },
            { api: API, marker: MARKER },
          );
          // An empty workspace shows a welcome instead of the dashboards: give it one real (marker-named) enquiry first.
          for (const [path, ready] of PAGES) {
            await page.goto(path);
            await expect(page.getByTestId(ready).first(), `${path} shows ${ready}`).toBeVisible({ timeout: 15_000 });
            await expect.poll(() => page.evaluate(() => document.documentElement.dataset.uiSize)).toBe(combo.interfaceSize);
            expect(await overflow(page), `${path} overflows`).toBeLessThanOrEqual(0);
            await shot(path.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, ""));
          }

          // Add Lead and Log call: the form fits and the Save button stays on screen.
          await page.goto("/leads");
          await page.getByRole("button", { name: /add lead/i }).first().click();
          await expect(page.getByTestId("lead-phone-input")).toBeVisible();
          expect(await overflow(page), "Add Lead").toBeLessThanOrEqual(0);
          await page.waitForTimeout(400); // the drawer slides in
          const saveLead = (await page.getByRole("button", { name: "Save Lead" }).boundingBox())!;
          expect(saveLead.x + saveLead.width).toBeLessThanOrEqual(size.width);
          expect(saveLead.y + saveLead.height).toBeLessThanOrEqual(size.height);
          await shot("add-lead");
          await page.keyboard.press("Escape");

          await page.goto(`/journeys/${lead.journeyId}`);
          await page.getByRole("button", { name: "Log call" }).first().click();
          const sheet = page.getByTestId("log-call");
          await sheet.getByTestId("log-call-next-appointment").click();
          await expect(sheet.getByTestId("log-call-appt-time")).toBeVisible();
          expect(await overflow(page), "Log call").toBeLessThanOrEqual(0);
          expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth), "Log call drawer").toBeLessThanOrEqual(0);
          await page.waitForTimeout(400);
          const saveCall = (await sheet.getByTestId("log-call-save").boundingBox())!;
          expect(saveCall.x + saveCall.width).toBeLessThanOrEqual(size.width);
          expect(saveCall.y + saveCall.height).toBeLessThanOrEqual(size.height);
          await shot("log-call");
          expect(errors, "page errors").toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});

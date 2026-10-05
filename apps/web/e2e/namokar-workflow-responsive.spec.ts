import { expect, test, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// The screens touched by the configurable-workflow patch, at the three sizes that matter for the demo: desktop, tablet, phone.
// No horizontal scrolling anywhere (page or drawer), and the new controls keep a 44px touch target on a phone.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const MARKER = "QA V2 ";
const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
];

async function login(page: Page) {
  await page.goto("/login/namokar-v2");
  await page.getByLabel("Email address").fill("namokarv2.superadmin@pulseos.local");
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
const pageOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const dialogOverflow = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);

test.describe("Configurable workflow screens: responsive", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => {
    purgePatients(MARKER);
    sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = 'namokar-v2')`);
  });

  for (const size of SIZES) {
    test(`${size.name}: CRM Fields, Clinic Hours, Doctor Planner, Add Lead and Log Call (with the appointment fields) fit without sideways scrolling`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
      const page = await context.newPage();
      await login(page);
      const shot = (name: string) => page.screenshot({ path: `review-artifacts/workflow-${size.name}-${name}.png`, fullPage: false });

      await page.goto("/settings?section=fields");
      await expect(page.getByTestId("crm-fields-section")).toBeVisible();
      expect(await pageOverflow(page), "CRM Fields").toBeLessThanOrEqual(0);
      const toggle = page.getByTestId("field-add-lead-diabetes");
      await expect(toggle).toBeAttached();
      if (size.width < 768) expect((await toggle.boundingBox())!.height, "Add Lead switch is a phone-sized target").toBeGreaterThanOrEqual(43.5);
      await shot("crm-fields");

      await page.goto("/settings?section=hours");
      await expect(page.getByTestId("clinic-hours-section")).toBeVisible();
      expect(await pageOverflow(page), "Clinic Hours").toBeLessThanOrEqual(0);
      await shot("clinic-hours");

      await page.goto("/appointments?view=doctors");
      await expect(page.getByTestId("doctor-schedule-view")).toBeVisible();
      await expect(page.getByTestId("doctor-schedule-date")).toBeVisible();
      expect(await pageOverflow(page), "Doctor Planner").toBeLessThanOrEqual(0);
      await shot("doctor-planner");

      await page.goto("/leads");
      await page.getByRole("button", { name: /add lead/i }).first().click();
      await expect(page.getByTestId("lead-phone-input")).toBeVisible();
      expect(await pageOverflow(page), "Add Lead").toBeLessThanOrEqual(0);
      await shot("add-lead");
      await page.keyboard.press("Escape");

      // Log Call with the appointment fields revealed - on a real (marker-named) journey.
      const lead = await page.evaluate(
        async ({ api, marker }) => {
          const lk = await (await fetch(`${api}/lookups`, { credentials: "include" })).json();
          const res = await fetch(`${api}/leads`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: `${marker}Responsive`, phone: "+919000000053", specialtyKey: "CATARACT", branchId: lk.branches[0].id, journeyType: "Cataract", source: "phone", sourceKey: "phone", customFieldValues: {} }),
          });
          return res.json();
        },
        { api: API, marker: MARKER },
      );
      await page.goto(`/journeys/${lead.journeyId}`);
      await page.getByRole("button", { name: "Log call" }).first().click();
      const sheet = page.getByTestId("log-call");
      await sheet.getByTestId("log-call-next-appointment").click();
      await expect(sheet.getByTestId("log-call-appt-time")).toBeVisible();
      expect(await pageOverflow(page), "Log Call").toBeLessThanOrEqual(0);
      expect(await dialogOverflow(page, "log-call"), "Log Call drawer").toBeLessThanOrEqual(0);
      if (size.width < 768) {
        for (const id of ["log-call-appt-date", "log-call-appt-time", "log-call-appt-confirmed", "log-call-save"]) expect((await sheet.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(43.5);
      }
      await shot("log-call");
      await page.keyboard.press("Escape");

      // Log outcome on a follow-up with the visit booked in the same save.
      await page.goto(`/journeys/${lead.journeyId}`);
      await page.getByTestId("journey-log-outcome").click();
      const outcome = page.getByTestId("log-outcome");
      await outcome.getByTestId("log-outcome-choice-interested").click();
      await outcome.getByTestId("log-outcome-book").check();
      await expect(outcome.getByTestId("log-outcome-appt-time")).toBeVisible();
      expect(await pageOverflow(page), "Log outcome").toBeLessThanOrEqual(0);
      expect(await dialogOverflow(page, "log-outcome"), "Log outcome drawer").toBeLessThanOrEqual(0);
      if (size.width < 768) {
        for (const id of ["log-outcome-appt-date", "log-outcome-appt-time", "log-outcome-save"]) expect((await outcome.getByTestId(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(43.5);
      }
      await shot("log-outcome");
      await page.keyboard.press("Escape");

      // Settings tab strip: with overflow, the scroll buttons are phone-sized and the page never scrolls sideways.
      await page.goto("/settings");
      await expect(page.getByRole("tablist", { name: "Settings sections" })).toBeVisible();
      expect(await pageOverflow(page), "Settings tabs").toBeLessThanOrEqual(0);
      const more = page.getByTestId("tabs-scroll-right");
      if ((await more.count()) > 0 && size.width < 768) expect((await more.first().boundingBox())!.height, "scroll button").toBeGreaterThanOrEqual(43.5);
      await shot("settings-tabs");
      await context.close();
    });
  }
});

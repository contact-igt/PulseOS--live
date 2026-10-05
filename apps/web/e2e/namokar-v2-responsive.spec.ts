import { expect, test, type Page } from "@playwright/test";

// Namokar V2 (clean workspace) at the three priority widths: nothing overflows sideways, no one-option Branch/Doctor chooser
// appears, and the appointment form's controls are tappable on a phone.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const WIDTHS = [{ w: 1440, h: 900 }, { w: 768, h: 1024 }, { w: 390, h: 844 }];

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("Namokar V2 responsive", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  for (const { w, h } of WIDTHS) {
    test(`${w}x${h}: login, empty Command Centre, Leads, My Work, Front Desk, Book Appointment`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await context.newPage();

      await page.goto("/login/namokar-v2");
      await expect(page.getByTestId("tenant-login")).toBeVisible();
      expect(await overflow(page), "login").toBeLessThanOrEqual(0);

      await page.getByLabel("Email address").fill("namokarv2.admin@pulseos.local");
      await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);

      for (const path of ["/command-centre", "/leads", "/my-work", "/front-desk"]) {
        await page.goto(path);
        await page.waitForLoadState("domcontentloaded");
        await expect(page.locator("main")).toBeVisible();
        expect(await overflow(page), path).toBeLessThanOrEqual(0);
        // One branch, one doctor: no chooser offering a single option anywhere on the page.
        await expect(page.getByLabel("Branch", { exact: true })).toHaveCount(0);
        await expect(page.getByLabel("Doctor", { exact: true })).toHaveCount(0);
      }

      // The empty workspace reads as ready, not broken, at every width.
      await page.goto("/command-centre");
      await expect(page.getByText("Your workspace is ready")).toBeVisible();

      // Book Appointment: needs a patient, so it is opened from the Appointments page; it must not overflow and has no branch/doctor boxes.
      await page.goto("/appointments");
      const open = page.getByTestId("new-appointment-button");
      if (await open.count()) {
        await open.click();
        const drawer = page.getByRole("dialog");
        await expect(drawer).toBeVisible();
        expect(await overflow(page), "appointment drawer").toBeLessThanOrEqual(0);
        await expect(drawer.locator("#appt-branch")).toHaveCount(0);
        await expect(drawer.locator("#appt-doctor")).toHaveCount(0);
        if (w <= 390) {
          const submit = await drawer.getByTestId("new-appointment-submit").boundingBox();
          expect(submit!.height, "submit tap target").toBeGreaterThanOrEqual(40);
        }
      }
      await context.close();
    });
  }
});

import { expect, test, type Browser, type Page } from "@playwright/test";
import { sql } from "./support/fixtures";

// The Oct 5 Namokar feedback, end to end: personal Display settings (interface size + text size, per person, never shared), Add
// service from Settings, and the clearer funnel (no Contacted, Procedure done). Everything written is removed afterwards.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const V1 = { slug: "namokar-v1", prefix: "namokar" };
const V2 = { slug: "namokar-v2", prefix: "namokarv2" };
const SERVICE = "QA Glaucoma Service";

async function login(page: Page, ws: { slug: string; prefix: string }, who: string) {
  await page.goto(`/login/${ws.slug}`);
  await page.getByLabel("Email address").fill(`${ws.prefix}.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
async function as(browser: Browser, ws: { slug: string; prefix: string }, who: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await login(page, ws, who);
  return { page, context };
}
const put = (page: Page, body: object) =>
  page.evaluate(async ({ api, body }) => (await fetch(`${api}/me/preferences`, { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { api: API, body });

/** What the design tokens actually produce on screen: the px size of a standard text class and of a standard control height. */
const measure = (page: Page) =>
  page.evaluate(() => {
    const probe = (cls: string, prop: "fontSize" | "height") => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.position = "absolute";
      d.style.visibility = "hidden";
      document.body.append(d);
      const v = parseFloat(getComputedStyle(d)[prop]);
      d.remove();
      return Math.round(v * 100) / 100;
    };
    return { ui: document.documentElement.dataset.uiSize, text: document.documentElement.dataset.textSize, textSm: probe("text-sm", "fontSize"), textXs: probe("text-xs", "fontSize"), control: probe("h-11", "height") };
  });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const cleanV2 = () => {
  sql(`UPDATE users SET interface_size = NULL, text_size = NULL WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`);
  sql(`DELETE FROM custom_field_definitions WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}') AND specialty_key LIKE 'QA_%'`);
  sql(`DELETE FROM specialty_templates WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}') AND key LIKE 'QA_%'`);
  sql(`DELETE FROM activity_log WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V2.slug}')`);
};

test.describe("Namokar feedback: display settings, add service, clearer funnel", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(cleanV2);
  test.afterAll(cleanV2);

  test("1. Display settings are personal: preview first, Save applies, it persists across reload and sign-in, and nobody else changes", async ({ browser }) => {
    test.setTimeout(120_000);
    const fd = await as(browser, V2, "frontdesk");
    try {
      const base = await measure(fd.page);
      expect(base).toMatchObject({ ui: "comfortable", text: "default", textSm: 14, control: 44 });

      await fd.page.getByTestId("profile-menu-trigger").click();
      await fd.page.getByTestId("display-settings-item").click();
      const sheet = fd.page.getByTestId("display-settings");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("display-save")).toBeDisabled(); // nothing changed yet
      await sheet.getByTestId("display-interface-large").check();
      await sheet.getByTestId("display-text-large").check();
      // The preview shows it at once; the real interface does not change until Save.
      await expect(sheet.getByTestId("appearance-preview")).toHaveAttribute("data-ui-size", "large");
      await expect(sheet.getByTestId("appearance-preview")).toHaveAttribute("data-text-size", "large");
      expect(await measure(fd.page)).toMatchObject({ ui: "comfortable", text: "default" });
      await sheet.getByTestId("display-save").click();
      await expect(sheet).toHaveCount(0);

      const big = await measure(fd.page);
      expect(big).toMatchObject({ ui: "large", text: "large" });
      expect(big.control).toBeCloseTo(48.4, 1); // roomier controls (11 x 0.275rem)
      expect(big.textSm).toBeCloseTo(15.68, 1); // 14px x 1.12
      expect(sql(`SELECT interface_size || '/' || text_size FROM users WHERE email = 'namokarv2.frontdesk@pulseos.local'`)).toBe("large/large");

      // Cancel discards.
      await fd.page.getByTestId("profile-menu-trigger").click();
      await fd.page.getByTestId("display-settings-item").click();
      await fd.page.getByTestId("display-text-small").check();
      await fd.page.getByTestId("display-cancel").click();
      expect(await measure(fd.page)).toMatchObject({ ui: "large", text: "large" });

      // Survives a reload and a fresh sign-in (it belongs to the person, not the browser).
      await fd.page.reload();
      await expect(fd.page.getByTestId("profile-menu-trigger")).toBeVisible();
      expect(await measure(fd.page)).toMatchObject({ ui: "large", text: "large" });
      await fd.page.getByTestId("profile-menu-trigger").click();
      await fd.page.getByTestId("logout-button").click();
      await fd.page.waitForURL(/\/login\//);
      await login(fd.page, V2, "frontdesk");
      await expect(fd.page.getByTestId("profile-menu-trigger")).toBeVisible();
      await expect.poll(async () => (await measure(fd.page)).ui).toBe("large");
      expect(await measure(fd.page)).toMatchObject({ ui: "large", text: "large" });

      // Colleagues keep their own: Shivani never chose (standard), Sushil chose Compact UI with Large text, the doctor never chose.
      const shivani = await as(browser, V2, "shivani");
      const sushil = await as(browser, V2, "sushil");
      const doctor = await as(browser, V2, "doctor");
      try {
        expect(await put(sushil.page, { interfaceSize: "compact", textSize: "large" })).toBe(200);
        await sushil.page.reload();
        await expect(sushil.page.getByTestId("profile-menu-trigger")).toBeVisible();
        const s = await measure(sushil.page);
        expect(s).toMatchObject({ ui: "compact", text: "large" }); // independent: tight UI, big text
        expect(s.control).toBeCloseTo(39.6, 1);
        expect(s.textSm).toBeCloseTo(15.68, 1);
        expect(await measure(shivani.page)).toMatchObject({ ui: "comfortable", text: "default", textSm: 14, control: 44 });
        expect(await measure(doctor.page)).toMatchObject({ ui: "comfortable", text: "default", textSm: 14, control: 44 });
        expect(await measure(fd.page)).toMatchObject({ ui: "large", text: "large" });
        // It is not the hospital's setting: the other hospital and the hospital's own interface style are untouched.
        expect(sql(`SELECT count(*) FROM users WHERE tenant_id = (SELECT id FROM tenants WHERE login_slug = '${V1.slug}') AND (interface_size IS NOT NULL OR text_size IS NOT NULL)`)).toBe("0");
      } finally {
        await shivani.context.close();
        await sushil.context.close();
        await doctor.context.close();
      }
    } finally {
      await fd.context.close();
    }
  });

  test("2. the largest settings keep the workflow screens usable on a phone, and Compact never shrinks phone touch targets", async ({ browser }) => {
    test.setTimeout(120_000);
    const phone = { width: 390, height: 844 };
    const big = await as(browser, V2, "shivani", phone);
    try {
      expect(await put(big.page, { interfaceSize: "large", textSize: "xlarge" })).toBe(200);
      for (const path of ["/my-work", "/leads", "/front-desk", "/appointments", "/settings"]) {
        await big.page.goto(path);
        await expect(big.page.getByTestId("profile-menu-trigger")).toBeVisible();
        expect(await overflow(big.page), `${path} at Large + Extra large`).toBeLessThanOrEqual(0);
      }
      await big.page.goto("/leads");
      await big.page.getByRole("button", { name: /add lead/i }).first().click();
      await expect(big.page.getByTestId("lead-phone-input")).toBeVisible();
      expect(await overflow(big.page), "Add Lead at Large + Extra large").toBeLessThanOrEqual(0);
      const save = await big.page.getByRole("button", { name: "Save Lead" }).boundingBox();
      expect(save!.x + save!.width).toBeLessThanOrEqual(phone.width); // the action button is not pushed off the screen

      expect(await put(big.page, { interfaceSize: "compact", textSize: "small" })).toBe(200);
      await big.page.goto("/my-work");
      await expect(big.page.getByTestId("profile-menu-trigger")).toBeVisible();
      const m = await measure(big.page);
      expect(m).toMatchObject({ ui: "compact", text: "small" });
      expect(m.control).toBe(44); // on a phone Compact does not apply: full-size touch targets
      expect(m.textXs).toBeGreaterThanOrEqual(11); // Small never goes below a readable size
      expect(await overflow(big.page)).toBeLessThanOrEqual(0);
    } finally {
      await big.context.close();
    }
  });

  test("3. Super Admin adds a service from Settings; Add Lead offers it at once; another hospital does not", async ({ browser }) => {
    const admin = await as(browser, V2, "superadmin");
    try {
      await admin.page.goto("/settings");
      await admin.page.getByTestId("add-service-name").fill(SERVICE);
      await admin.page.getByTestId("add-service-save").click();
      await expect(admin.page.getByTestId("specialty-list")).toContainText(SERVICE);
      await admin.page.goto("/leads");
      await admin.page.getByRole("button", { name: /add lead/i }).first().click();
      await expect(admin.page.getByLabel("Service / enquiry").locator("option", { hasText: SERVICE })).toHaveCount(1);
      // A duplicate is refused with a clear message.
      await admin.page.goto("/settings");
      await admin.page.getByTestId("add-service-name").fill(SERVICE.toLowerCase());
      await admin.page.getByTestId("add-service-save").click();
      await expect(admin.page.getByTestId("add-service-error")).toContainText("already exists");

      const v1 = await as(browser, V1, "admin");
      try {
        await v1.page.goto("/settings");
        await expect(v1.page.getByTestId("specialty-list")).not.toContainText(SERVICE);
      } finally {
        await v1.context.close();
      }
    } finally {
      await admin.context.close();
    }
  });

  test("4. the owner's funnel speaks in clinic terms: no Contacted step, Procedure done is there, a visit means the patient arrived", async ({ browser }) => {
    const owner = await as(browser, V1, "admin");
    try {
      await owner.page.goto("/command-centre?tab=performance&range=30d");
      const funnel = owner.page.getByTestId("performance-view");
      await expect(funnel).toBeVisible();
      for (const key of ["enquiries", "booked", "attended", "consulted", "advised", "scheduled", "done"]) await expect(owner.page.getByTestId(`perf-funnel-${key}`)).toBeVisible();
      await expect(owner.page.getByTestId("perf-funnel-contacted")).toHaveCount(0);
      await expect(owner.page.getByTestId("perf-funnel-done")).toContainText("Procedure done");
      await expect(owner.page.getByTestId("perf-funnel-attended")).toContainText("Visit attended");
      await expect(owner.page.getByTestId("perf-kpis")).not.toContainText(/Contacted/);
      await expect(owner.page.getByTestId("perf-kpis")).toContainText("Procedures done");
    } finally {
      await owner.context.close();
    }
  });
});

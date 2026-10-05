import { expect, test, type Browser, type Page } from "@playwright/test";
import { sql } from "./support/fixtures";

// Interface style (Settings > Appearance) and the floating menus: solid enough to read, one open at a time, dismissible,
// and tenant-scoped (V1 Demo and V2 Pilot each keep their own style, read from the server).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";

type Workspace = "v1" | "v2";
const LOGIN = { v1: ["/login/namokar-v1", "namokar"], v2: ["/login/namokar-v2", "namokarv2"] } as const;

async function login(page: Page, ws: Workspace, who: "admin" | "frontdesk") {
  const [path, prefix] = LOGIN[ws];
  await page.goto(path);
  await page.getByLabel("Email address").fill(`${prefix}.${who}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}
async function as(browser: Browser, ws: Workspace, who: "admin" | "frontdesk", viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await login(page, ws, who);
  return { page, context };
}
const alphaOf = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => {
    const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor)!;
    const parts = m[1]!.split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  });
const surface = (page: Page) => page.evaluate(() => document.documentElement.dataset.surface ?? null);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const resetStyles = () => sql(`UPDATE tenants SET surface_style = NULL WHERE login_slug IN ('namokar-v1', 'namokar-v2')`);

test.describe("floating menus", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("Create and account menus are solid floating surfaces (never the old see-through glass)", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin");
    await page.goto("/leads");
    await page.getByTestId("quick-create-button").click();
    await expect(page.getByTestId("quick-create-menu")).toHaveClass(/floating/);
    expect(await alphaOf(page, "quick-create-menu")).toBeGreaterThanOrEqual(0.92);
    await page.getByTestId("profile-menu-trigger").click();
    await expect(page.getByTestId("profile-menu")).toHaveClass(/floating/);
    expect(await alphaOf(page, "profile-menu")).toBeGreaterThanOrEqual(0.92);
    await context.close();
  });

  test("opening one top-bar menu closes the other, both ways", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin");
    await page.goto("/leads");
    await page.getByTestId("quick-create-button").click();
    await expect(page.getByTestId("quick-create-menu")).toBeVisible();
    await page.getByTestId("profile-menu-trigger").click();
    await expect(page.getByTestId("quick-create-menu")).toHaveCount(0);
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    await page.getByTestId("quick-create-button").click();
    await expect(page.getByTestId("profile-menu")).toHaveCount(0);
    await expect(page.getByTestId("quick-create-menu")).toBeVisible();
    await context.close();
  });

  test("Escape closes a menu and returns focus to its button; a click outside closes it", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin");
    await page.goto("/leads");
    for (const [trigger, menu] of [["quick-create-button", "quick-create-menu"], ["profile-menu-trigger", "profile-menu"]] as const) {
      await page.getByTestId(trigger).click();
      await expect(page.getByTestId(menu)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(menu)).toHaveCount(0);
      await expect(page.getByTestId(trigger)).toBeFocused();
      await page.getByTestId(trigger).click();
      await page.mouse.click(300, 600); // somewhere on the page
      await expect(page.getByTestId(menu)).toHaveCount(0);
    }
    await context.close();
  });

  test("at 390px the menus fit the screen (no sideways scroll) and stay solid", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin", { width: 390, height: 844 });
    await page.goto("/leads");
    await page.getByTestId("quick-create-button").click();
    await expect(page.getByTestId("quick-create-menu")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await alphaOf(page, "quick-create-menu")).toBeGreaterThanOrEqual(0.95);
    await page.getByTestId("profile-menu-trigger").click();
    await expect(page.getByTestId("profile-menu")).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await context.close();
  });
});

test.describe("Settings > Appearance (per hospital)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.beforeAll(resetStyles);
  test.afterAll(resetStyles);

  test("a hospital with no saved style is Balanced; the preview follows the choice before saving; Cancel restores", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin");
    await expect.poll(() => surface(page)).toBe("balanced");
    await page.goto("/settings?section=appearance");
    await expect(page.getByTestId("appearance-option-balanced")).toBeChecked();
    await page.getByTestId("appearance-option-solid").check({ force: true });
    await expect(page.getByTestId("appearance-preview")).toHaveAttribute("data-surface", "solid");
    await expect.poll(() => alphaOf(page, "preview-menu")).toBe(1);
    await expect.poll(() => surface(page)).toBe("balanced"); // the real interface changes only on Save
    await page.getByTestId("appearance-option-airy").check({ force: true });
    await expect.poll(() => alphaOf(page, "preview-menu")).toBeLessThan(0.96);
    expect(await alphaOf(page, "preview-menu")).toBeGreaterThanOrEqual(0.92); // even the airiest menu stays near-opaque
    await page.getByTestId("appearance-cancel").click();
    await expect(page.getByTestId("appearance-option-balanced")).toBeChecked();
    await expect(page.getByTestId("appearance-preview")).toHaveAttribute("data-surface", "balanced");
    await context.close();
  });

  test("V1 and V2 each keep their own style: V1 Solid and V2 Airy at the same time, surviving reload and sign-out", async ({ browser }) => {
    const v1 = await as(browser, "v1", "admin");
    const v2 = await as(browser, "v2", "admin");
    await v1.page.goto("/settings?section=appearance");
    await v1.page.getByTestId("appearance-option-solid").check({ force: true });
    await v1.page.getByTestId("appearance-save").click();
    await expect(v1.page.getByTestId("appearance-notice")).toBeVisible();
    await expect.poll(() => surface(v1.page)).toBe("solid");

    await v2.page.reload();
    await expect.poll(() => surface(v2.page)).toBe("balanced"); // V1's change did not reach V2
    await v2.page.goto("/settings?section=appearance");
    await v2.page.getByTestId("appearance-option-airy").check({ force: true });
    await v2.page.getByTestId("appearance-save").click();
    await expect(v2.page.getByTestId("appearance-notice")).toBeVisible();
    await expect.poll(() => surface(v2.page)).toBe("airy");

    await v1.page.reload();
    await v2.page.reload();
    await expect.poll(() => surface(v1.page)).toBe("solid");
    await expect.poll(() => surface(v2.page)).toBe("airy");
    await v1.page.getByTestId("quick-create-button").click();
    await v2.page.getByTestId("quick-create-button").click();
    await expect.poll(() => alphaOf(v1.page, "quick-create-menu")).toBe(1);
    await expect.poll(() => alphaOf(v2.page, "quick-create-menu")).toBeLessThan(0.96);

    // Server-side, not the browser: a fresh browser signing in again gets the same style.
    const again = await as(browser, "v1", "admin");
    await expect.poll(() => surface(again.page)).toBe("solid");
    expect(sql(`SELECT string_agg(login_slug || '=' || coalesce(surface_style, 'default'), ',' ORDER BY login_slug) FROM tenants WHERE login_slug IN ('namokar-v1','namokar-v2')`)).toBe("namokar-v1=solid,namokar-v2=airy");
    for (const c of [v1.context, v2.context, again.context]) await c.close();
  });

  test("a failed save keeps the chosen style and says so inline", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "admin");
    await page.goto("/settings?section=appearance");
    await page.route("**/appearance", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.getByTestId("appearance-option-airy").check({ force: true });
    await page.getByTestId("appearance-save").click();
    await expect(page.getByTestId("appearance-error")).toContainText(/could not save/i);
    await expect(page.getByTestId("appearance-option-airy")).toBeChecked();
    await expect(page.getByTestId("appearance-preview")).toHaveAttribute("data-surface", "airy");
    await context.close();
  });

  test("front desk neither sees the Appearance tab nor can change it directly", async ({ browser }) => {
    const { page, context } = await as(browser, "v1", "frontdesk");
    await page.goto("/settings");
    await expect(page.getByRole("tab", { name: "Appearance" })).toHaveCount(0);
    const status = await page.evaluate(async (api) => (await fetch(`${api}/appearance`, { method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ surfaceStyle: "airy" }) })).status, API);
    expect(status).toBe(403);
    await context.close();
  });
});

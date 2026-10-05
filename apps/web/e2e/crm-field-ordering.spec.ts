import { test, expect, type Page } from "@playwright/test";
import { purgeCrmFields, sql } from "./support/fixtures";

// Settings → CRM Fields ordering: drag the grip, or use the keyboard / arrow buttons; the order is saved on the server
// and survives a refresh. Three fictional fields in their own group, removed afterwards.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const RUN = Date.now().toString().slice(-8);
const KEYS = ["a", "b", "c"].map((x) => `e2e_order_${x}_${RUN}`);
const API = "http://localhost:4310";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

const order = (page: Page) => page.locator('[data-testid="field-group-follow_up_details"] [data-testid^="field-row-e2e_order_"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")!.replace("field-row-", "")));
const dbOrder = () => sql(`SELECT string_agg(key, ',' ORDER BY sort_order) FROM custom_field_definitions WHERE key LIKE 'e2e_order_%_${RUN}'`).split(",");

test.describe("CRM field ordering", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => purgeCrmFields("e2e_order_"));

  test("drag the handle, then the keyboard, then the arrows — each order is saved and survives refresh; clicking a row still edits", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    for (const [i, key] of KEYS.entries()) {
      const res = await page.request.post(`${API}/crm/fields`, { data: { specialtyKey: "CATARACT", key, label: `E2E Order ${"ABC"[i]} ${RUN}`, fieldType: "TEXT", groupKey: "follow_up_details" } });
      expect(res.status(), await res.text()).toBe(201);
    }
    await page.goto("/settings?section=fields&service=CATARACT");
    await expect.poll(() => order(page)).toEqual(KEYS);

    // Pointer drag: C's grip onto A's row.
    const grip = page.getByTestId(`field-drag-${KEYS[2]}`);
    const target = page.getByTestId(`field-row-${KEYS[0]}`);
    await grip.scrollIntoViewIfNeeded();
    const g = (await grip.boundingBox())!;
    const t = (await target.boundingBox())!;
    const saved = page.waitForResponse((r) => r.url().includes("/crm/fields/reorder") && r.ok());
    await grip.hover();
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 12, { steps: 6 });
    await expect(page.locator(`[data-testid="field-row-${KEYS[2]}"][data-dragging]`)).toHaveCount(1);
    await page.mouse.move(t.x + 40, t.y + 4, { steps: 12 });
    await page.mouse.up();
    await saved;
    await expect.poll(() => order(page)).toEqual([KEYS[2], KEYS[0], KEYS[1]]);
    expect(dbOrder()).toEqual([KEYS[2], KEYS[0], KEYS[1]]);
    await expect(page.getByTestId(`field-position-${KEYS[2]}`)).toHaveText("1");

    // Rows are locked while a save is in flight; wait for the list to settle.
    const settled = () => expect(page.locator('[data-testid="field-group-follow_up_details"] ul')).toHaveAttribute("aria-busy", "false");
    await settled();
    // Keyboard drag: focus B's grip, pick up with Space, move up once, drop.
    const saved2 = page.waitForResponse((r) => r.url().includes("/crm/fields/reorder") && r.ok());
    await page.getByTestId(`field-drag-${KEYS[1]}`).focus();
    await page.keyboard.press("Space");
    await expect(page.locator(`[data-testid="field-row-${KEYS[1]}"][data-dragging]`)).toHaveCount(1);
    // Arrow up until the screen-reader announcement names position 2 (one live region per group).
    const overTwo = page.locator('[id^="DndLiveRegion"]', { hasText: "is over position 2 of 3" });
    await expect(async () => {
      if ((await overTwo.count()) === 0) await page.keyboard.press("ArrowUp");
      await expect(overTwo).toHaveCount(1, { timeout: 500 });
    }).toPass({ timeout: 5000 });
    await page.keyboard.press("Space");
    await saved2;
    await expect.poll(() => order(page)).toEqual([KEYS[2], KEYS[1], KEYS[0]]);

    await settled();
    // Arrow buttons (the touch / no-drag path).
    await page.getByTestId(`field-move-down-${KEYS[2]}`).click();
    await expect.poll(() => order(page)).toEqual([KEYS[1], KEYS[2], KEYS[0]]);
    await expect.poll(dbOrder).toEqual([KEYS[1], KEYS[2], KEYS[0]]);

    await page.reload();
    await expect.poll(() => order(page)).toEqual([KEYS[1], KEYS[2], KEYS[0]]);

    // The row itself is still a normal click target (Edit), never a drag start.
    await page.getByTestId(`field-edit-${KEYS[0]}`).click();
    await expect(page.getByTestId("field-label")).toHaveValue(`E2E Order A ${RUN}`);
  });

  test("a failed save puts the order back and says so", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=fields&service=CATARACT");
    await expect.poll(async () => (await order(page)).length).toBe(3);
    const before = await order(page);
    await page.route("**/crm/fields/reorder", (route) => route.fulfill({ status: 500, body: '{"error":"internal_error"}', contentType: "application/json" }));
    await page.getByTestId(`field-move-down-${before[0]}`).click();
    await expect(page.getByTestId("crm-fields-error")).toContainText("put back");
    await expect.poll(() => order(page)).toEqual(before);
  });

  test("phones keep the handle (a 44px target) and the arrow buttons; unrendered placements are not offered", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=fields&service=CATARACT");
    await expect.poll(async () => (await order(page)).length).toBe(3);
    const first = (await order(page))[0]!;
    await expect(page.getByTestId(`field-drag-${first}`)).toBeVisible();
    expect((await page.getByTestId(`field-drag-${first}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId(`field-move-down-${first}`)).toBeVisible();
    await page.getByTestId("crm-fields-add").click();
    await expect(page.getByTestId("field-placement-add_lead")).toBeVisible();
    await expect(page.getByTestId("field-placement-appointment")).toHaveCount(0);
    await expect(page.getByTestId("field-placement-treatment")).toHaveCount(0);
  });
});

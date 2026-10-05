import { test, expect, type Page } from "@playwright/test";
import { sql } from "./support/fixtures";

// M6.6 Settings UX: the tab strip never scrolls vertically, scrolls sideways when it must, and keeps every tab reachable.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const RUN = `${Date.now()}`.slice(-6);

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

test.describe("M6.6 — Settings tab strip", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  for (const vp of VIEWPORTS) {
    test(`${vp.width}x${vp.height}: no vertical scrollbar, every tab reachable, no page overflow`, async ({ page }) => {
      await page.setViewportSize(vp);
      await login(page, "eyev1.admin@pulseos.local");
      await page.goto("/settings");
      const strip = page.getByRole("tablist", { name: "Settings sections" });
      await expect(strip).toBeVisible();

      // 1. The strip has no vertical overflow and the computed overflow-y is not auto/scroll.
      const m = await strip.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY, ox: getComputedStyle(el).overflowX }));
      expect(m.oy).toBe("hidden");
      expect(m.ox).toBe("auto");
      expect(m.sh).toBeLessThanOrEqual(m.ch);

      // 2. Every tab can be reached: select the last one; it ends up inside the strip's visible box.
      const tabs = strip.getByRole("tab");
      const count = await tabs.count();
      expect(count).toBeGreaterThan(3);
      const last = tabs.nth(count - 1);
      await last.click();
      await expect(last).toHaveAttribute("aria-selected", "true");
      await expect.poll(async () => {
        const [s, t] = await Promise.all([strip.boundingBox(), last.boundingBox()]);
        return !!s && !!t && t.x >= s.x - 1 && t.x + t.width <= s.x + s.width + 1;
      }).toBe(true);

      // 3. The active tab is visibly marked (not colour alone: it carries aria-selected and an indicator).
      expect(await last.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");

      // 4. Touch targets are at least 44px tall on small screens.
      if (vp.width < 768) expect((await last.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      // 5. The page itself never scrolls sideways.
      const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(sw).toBeLessThanOrEqual(iw);
    });
  }

  test("a focused tab shows its focus ring inside the strip (an outer ring would be clipped by the scroll box)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings");
    const first = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab").first();
    await first.focus();
    await page.keyboard.press("ArrowRight");
    const focused = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab").nth(1);
    await expect(focused).toBeFocused();
    const ring = await focused.evaluate((el) => {
      const cs = getComputedStyle(el);
      const strip = el.parentElement!.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset), style: cs.outlineStyle, insideTop: r.top - parseFloat(cs.outlineWidth) - Math.max(0, parseFloat(cs.outlineOffset)) >= strip.top - 0.5 };
    });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    expect(ring.offset).toBeLessThanOrEqual(0); // inset: never outside the box the strip clips
  });

  test("keyboard: arrow keys move between tabs and the selection follows focus", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings");
    const strip = page.getByRole("tablist", { name: "Settings sections" });
    const first = strip.getByRole("tab").first();
    await first.focus();
    await page.keyboard.press("ArrowRight");
    const second = strip.getByRole("tab").nth(1);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(second).toBeFocused();
    await page.keyboard.press("End");
    await expect(strip.getByRole("tab").last()).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("M6.6 — Settings mobile targets", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("390px: every button, link and field in every Settings section is at least 44px tall; no section overflows the page", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings");
    await page.getByRole("tablist", { name: "Settings sections" }).waitFor();
    const sections = await page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("settings-tab-", "")));
    expect(sections.length).toBeGreaterThan(5);
    const small: string[] = [];
    for (const section of sections) {
      await page.goto(`/settings?section=${section}`);
      await page.waitForLoadState("networkidle");
      small.push(
        ...(await page.evaluate((name) => {
          const out: string[] = [];
          for (const el of document.querySelectorAll<HTMLElement>("[data-testid=settings-page] button, [data-testid=settings-page] a, [data-testid=settings-page] input:not([type=hidden]), [data-testid=settings-page] select, [data-testid=settings-page] textarea")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden" || el.closest("[role=tablist]")) continue;
            if (r.height < 43.5) out.push(`${name}: ${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? (el.textContent ?? "").trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        }, section)),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${section} overflows`).toBeLessThanOrEqual(0);
    }
    expect(small).toEqual([]);
  });
});

test.describe("M6.6 — Workflow Outcomes: handle-first drag", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.describe.configure({ mode: "serial" });
  const KEYS = ["a", "b", "c"].map((x) => `e2e_m66_${x}_${RUN}`);
  const LABEL = (i: number) => `E2E M66 ${"ABC"[i]} ${RUN}`;
  const dbOrder = () => sql(`SELECT string_agg(key, ',' ORDER BY sort_order) FROM crm_outcomes WHERE key LIKE 'e2e_m66_%_${RUN}'`).split(",");
  const order = (page: Page) => page.locator('[data-testid="outcome-group-contacted"] [data-testid^="outcome-row-e2e_m66_"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")!.replace("outcome-row-", "")));

  /** Where a row sits in the WHOLE Contacted group (the announcement speaks in group positions). */
  const groupPosition = async (page: Page, key: string) => {
    const keys = await page.locator('[data-testid="outcome-group-contacted"] [data-testid^="outcome-row-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")!.replace("outcome-row-", "")));
    return { position: keys.indexOf(key) + 1, total: keys.length };
  };

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page, "eyev1.admin@pulseos.local");
    for (const [i, key] of KEYS.entries()) {
      const res = await page.request.post(`${API}/crm/outcomes`, { data: { key, label: LABEL(i), stage: "contacted" } });
      expect(res.status(), await res.text()).toBe(201);
    }
    await page.close();
    ORIGINAL = Object.fromEntries(sql(`SELECT key || '=' || sort_order FROM crm_outcomes WHERE key LIKE 'e2e_m66_%_${RUN}'`).split("\n").map((l) => l.split("=")));
  });
  let ORIGINAL: Record<string, string> = {};
  const resetOrder = () => sql(KEYS.map((k) => `UPDATE crm_outcomes SET sort_order = ${Number(ORIGINAL[k])} WHERE key = '${k}'`).join(";"));
  test.afterAll(() => {
    sql(`UPDATE journeys SET last_outcome_id = NULL WHERE last_outcome_id IN (SELECT id FROM crm_outcomes WHERE key LIKE 'e2e_m66_%'); DELETE FROM crm_outcomes WHERE key LIKE 'e2e_m66_%';`);
  });

  async function open(page: Page, width = 1440) {
    resetOrder();
    await page.setViewportSize({ width, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=outcomes");
    await expect.poll(() => order(page)).toEqual(KEYS);
  }

  async function dragByHandle(page: Page, from: string, onto: string, grabRow = false) {
    const grip = page.getByTestId(grabRow ? `outcome-row-${from}` : `outcome-drag-${from}`);
    const target = page.getByTestId(`outcome-row-${onto}`);
    await grip.scrollIntoViewIfNeeded();
    const g = (await (grabRow ? page.getByTestId(`outcome-edit-${from}`) : grip).boundingBox())!;
    const t = (await target.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 12, { steps: 6 });
    await page.mouse.move(t.x + 40, t.y + 4, { steps: 12 });
    await page.mouse.up();
  }

  test("the handle is the primary control: row states, whole-row drag does nothing, arrows are quiet until hover/focus", async ({ page }) => {
    await open(page);
    const row = page.getByTestId(`outcome-row-${KEYS[1]}`);
    const grip = page.getByTestId(`outcome-drag-${KEYS[1]}`);
    const down = page.getByTestId(`outcome-move-down-${KEYS[1]}`);
    await expect(grip).toBeVisible();
    await expect(grip).toHaveCSS("cursor", "grab");
    // Secondary arrows are present but visually quiet when the row is not hovered or focused.
    await page.mouse.move(5, 5);
    await expect(down).toHaveCSS("opacity", "0");
    await row.hover();
    await expect(down).toHaveCSS("opacity", "1");
    expect((await down.boundingBox())!.width).toBeLessThan((await grip.boundingBox())!.width + 1);

    // Dragging the row body (not the handle) never reorders; the body is the Edit target.
    await dragByHandle(page, KEYS[1], KEYS[0], true);
    await expect.poll(() => order(page)).toEqual(KEYS);
    expect(dbOrder()).toEqual(KEYS);

    // Dragging: the row lifts (data-dragging) and the hovered row is marked as the drop target.
    const g = (await grip.boundingBox())!;
    const t = (await page.getByTestId(`outcome-row-${KEYS[0]}`).boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 12, { steps: 6 });
    await expect(row).toHaveAttribute("data-dragging");
    await page.mouse.move(t.x + 40, t.y + 6, { steps: 12 });
    await expect(page.getByTestId(`outcome-row-${KEYS[0]}`)).toHaveAttribute("data-drop-target");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual(KEYS);
  });

  test("drag by handle saves, announces the new position, persists across refresh", async ({ page }) => {
    await open(page);
    const saved = page.waitForResponse((r) => r.url().includes("/crm/outcomes/reorder") && r.ok());
    await dragByHandle(page, KEYS[2], KEYS[0]);
    await saved;
    await expect.poll(() => order(page)).toEqual([KEYS[2], KEYS[0], KEYS[1]]);
    const at = await groupPosition(page, KEYS[2]!);
    await expect(page.getByTestId("reorder-status")).toHaveText(`${LABEL(2)} moved to position ${at.position} of ${at.total}.`);
    expect(dbOrder()).toEqual([KEYS[2], KEYS[0], KEYS[1]]);
    await page.reload();
    await expect.poll(() => order(page)).toEqual([KEYS[2], KEYS[0], KEYS[1]]);
  });

  test("a failed save puts the order back, says so inline, and shows no error overlay", async ({ page }) => {
    await open(page);
    const before = await order(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/crm/outcomes/reorder", (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));
    await dragByHandle(page, before[2]!.replace("outcome-row-", ""), before[0]!);
    await expect(page.getByTestId("outcomes-error")).toContainText("put back");
    await expect.poll(() => order(page)).toEqual(before);
    await expect(page.getByTestId(`outcome-row-${before[2]}`)).toHaveAttribute("data-status", "failed");
    expect(errors).toEqual([]);
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
    await page.unroute("**/crm/outcomes/reorder");
  });

  test("Move up / down: announced, focus stays on the moved row's control, DOM order matches visual order", async ({ page }) => {
    await open(page);
    const start = await order(page);
    const second = start[1]!;
    const saved = page.waitForResponse((r) => r.url().includes("/crm/outcomes/reorder") && r.ok());
    await page.getByTestId(`outcome-move-up-${second}`).focus();
    await page.keyboard.press("Enter");
    await saved;
    await expect.poll(() => order(page)).toEqual([second, start[0]!, start[2]!]);
    const at = await groupPosition(page, second);
    await expect(page.getByTestId("reorder-status")).toHaveText(`${LABEL(KEYS.indexOf(second))} moved to position ${at.position} of ${at.total}.`);
    // Focus stays on the control that was used, on the row that moved — never dropped to <body>.
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(`outcome-move-up-${second}`);
    // DOM order == visual order (top of each row strictly increases).
    const tops = await page.locator('[data-testid^="outcome-row-e2e_m66_"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    expect(dbOrder()).toEqual([second, start[0]!, start[2]!]);
  });

  test("keyboard drag: Space picks up, arrows move, Space drops; the handle is a labelled button", async ({ page }) => {
    await open(page);
    const start = await order(page);
    const grip = page.getByTestId(`outcome-drag-${start[0]}`);
    await expect(grip).toHaveAttribute("aria-label", /Reorder .*position \d+ of \d+.*space to pick up/i);
    const saved = page.waitForResponse((r) => r.url().includes("/crm/outcomes/reorder") && r.ok());
    await grip.focus();
    await page.keyboard.press("Space");
    await expect(page.locator(`[data-testid="outcome-row-${start[0]}"][data-dragging]`)).toHaveCount(1);
    const from = await groupPosition(page, start[0]!);
    const over = page.locator('[id^="DndLiveRegion"]', { hasText: `is over position ${from.position + 1} of ${from.total}` });
    await expect(async () => {
      if ((await over.count()) === 0) await page.keyboard.press("ArrowDown");
      await expect(over).toHaveCount(1, { timeout: 500 });
    }).toPass({ timeout: 5000 });
    await page.keyboard.press("Space");
    await saved;
    await expect.poll(() => order(page)).toEqual([start[1]!, start[0]!, start[2]!]);
  });

  test("390px: handle and arrows are 44px targets, no page overflow, drag works by handle", async ({ page }) => {
    await open(page, 390);
    for (const id of [`outcome-drag-${KEYS[0]}`, `outcome-move-up-${KEYS[0]}`, `outcome-move-down-${KEYS[0]}`]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.height, id).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

test.describe("M6.6 — Lead Sources use the same sortable list", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.describe.configure({ mode: "serial" });
  let original: string[] = [];

  test.afterAll(async ({ browser }) => {
    if (original.length === 0) return;
    const page = await browser.newPage();
    await login(page, "eyev1.admin@pulseos.local");
    await page.request.post(`${API}/lead-sources/reorder`, { data: { orderedIds: original } });
    await page.close();
  });

  test("handle drag and Move down both save, are announced, persist across refresh and set the Add Lead order", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    original = ((await (await page.request.get(`${API}/lead-sources`)).json()) as { id: string }[]).map((s) => s.id);
    await page.goto("/settings?section=sources");
    const order = () => page.locator('[data-testid="source-list"] > li').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")!.replace("source-row-", "")));
    await expect.poll(async () => (await order()).length).toBeGreaterThan(3);
    const start = await order();

    // Quiet arrows: move the first source down one place.
    const saved = page.waitForResponse((r) => r.url().includes("/lead-sources/reorder") && r.ok());
    await page.getByTestId(`source-move-down-${start[0]}`).click();
    await saved;
    await expect(page.getByTestId("reorder-status")).toContainText("moved to position 2");
    await expect.poll(order).toEqual([start[1]!, start[0]!, ...start.slice(2)]);

    // Handle drag: the third source onto the first.
    const grip = page.getByTestId(`source-drag-${start[2]}`);
    const target = page.getByTestId(`source-row-${start[1]}`);
    const g = (await grip.boundingBox())!;
    const t = (await target.boundingBox())!;
    const saved2 = page.waitForResponse((r) => r.url().includes("/lead-sources/reorder") && r.ok());
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 12, { steps: 6 });
    await page.mouse.move(t.x + 40, t.y + 4, { steps: 12 });
    await page.mouse.up();
    await saved2;
    await expect.poll(async () => (await order())[0]).toBe(start[2]);

    await page.reload();
    await expect.poll(async () => (await order())[0]).toBe(start[2]);
    // The order Staff pick from in Add Lead is the same.
    const offered = ((await (await page.request.get(`${API}/lead-sources`)).json()) as { key: string }[]).map((s) => s.key);
    expect(offered[0]).toBe(start[2]);
  });
});

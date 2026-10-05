import { test, expect, type Page } from "@playwright/test";
import path from "path";

// Command Centre acceptance screenshots (funcional-hardening prompt §23) —
// verifies the Journey Health radial centering fix and Journey Funnel
// replacement hold up across every required breakpoint.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts/brain-review");

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("gyn.admin@pulseos.local");
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre/);
}

test.describe("Command Centre — responsive acceptance", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("captures 1440/1280/1024/768 and asserts no horizontal overflow", async ({ page }) => {
    // fullPage: false (viewport-only) deliberately — a fullPage capture with
    // this shell's `position: fixed` sidebar re-paints the sidebar at every
    // scrolled segment Playwright stitches together, producing a misleading
    // "sidebar overlapping content" artifact that doesn't reflect any real
    // runtime bug (confirmed by comparing against a live viewport render).
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await expect(page.getByTestId("journey-funnel")).toBeVisible();
    await expect(page.getByTestId("service-lines")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "command-centre-1440.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "command-centre-1280.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "command-centre-1024.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "command-centre-768.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  // Regression test for the 2026-09-21 UI Refinement V2 pass: the actual bugs
  // (a compact table overflowing its card, a heading word-breaking, a radial
  // legend truncated to 3-4 characters) were all invisible to the
  // document.scrollWidth check above, because the card that contained each
  // one used `overflow-hidden` — the overflow was real but silently clipped
  // at the card boundary rather than pushing out the page. This test asserts
  // the actual failure signatures directly, specifically at 1024px, the one
  // breakpoint where the prior audit pass never looked live.
  test("1024px: no panel clips its own content, no heading or legend label is truncated", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await login(page);
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await expect(page.getByTestId("service-lines")).toBeVisible();

    // No card's content should render wider than the card itself — this is
    // the generic signature of "table-layout: auto with overflow-hidden"
    // silently clipping content, whatever the specific cause.
    const overflowingCards = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid="command-centre"] .rounded-card'));
      return cards
        .filter((c) => c.scrollWidth > c.clientWidth + 1)
        .map((c) => ({ text: c.textContent?.slice(0, 40), overflowPx: c.scrollWidth - c.clientWidth }));
    });
    expect(overflowingCards, JSON.stringify(overflowingCards)).toEqual([]);

    // `truncate` (CSS text-overflow: ellipsis) doesn't change an element's
    // DOM text, only how it paints — so a text-content assertion like
    // getByText(...).toBeVisible() would pass even while the label reads
    // "Con..." on screen. scrollWidth > clientWidth on the truncating
    // element itself is what actually distinguishes "fits" from "visually
    // clipped", since the browser still lays out the untruncated content
    // internally even when it isn't painted.
    const truncatedHeadings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="command-centre"] h2'))
        .filter((h) => h.scrollWidth > h.clientWidth + 1)
        .map((h) => h.textContent),
    );
    expect(truncatedHeadings, "section heading(s) rendering truncated at 1024px").toEqual([]);

    // 2026-09-29 recomposition: the Journey Health radial (and its legend) was
    // replaced by the Service Lines panel, so the same "no visibly clipped
    // label" guarantee now covers service names and the Attention queue's
    // patient / journey / owner text at this width.
    const truncatedLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="service-lines"] span.truncate, [data-testid="attention-queue"] span.truncate'))
        .filter((s) => s.scrollWidth > s.clientWidth + 1)
        .map((s) => s.textContent),
    );
    expect(truncatedLabels, "Service Lines / Attention label(s) rendering truncated at 1024px").toEqual([]);
  });
});

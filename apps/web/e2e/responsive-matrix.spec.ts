import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Responsive gate: every primary page at the five required viewports must render
// without page-level horizontal overflow, without a Next runtime error overlay and
// without console/page errors. Read-only (navigation only). One screenshot per page
// per viewport lands in review-artifacts/responsive/ (gitignored).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const OUT = path.resolve(__dirname, "../../../review-artifacts/responsive");

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
];

async function devLoginAdmin(page: Page) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId("dev-login-env-ophthalmology").click();
  await page.getByTestId("dev-login-role-HOSPITAL_ADMIN").click();
  await page.waitForURL(/\/command-centre/);
}

async function settle(page: Page) {
  await page.waitForLoadState("load");
  // Queries resolve; skeletons are replaced. No networkidle: some pages poll.
  await page.waitForTimeout(1200);
}

async function expectHealthy(page: Page, label: string, problems: string[]) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${label}: page scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
  await expect(page.locator("[data-nextjs-dialog]"), `${label}: runtime error dialog`).toHaveCount(0);
  await expect(page.getByRole("button", { name: /issue/i }), `${label}: Next issues badge`).toHaveCount(0);
  expect(problems, `${label}: console / page errors`).toEqual([]);
}

test.describe("responsive matrix", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  test.beforeAll(() => fs.mkdirSync(OUT, { recursive: true }));

  for (const vp of VIEWPORTS) {
    test(`${vp.name}: login + every primary page`, async ({ page }) => {
      const problems: string[] = [];
      page.on("console", (m) => {
        // The expected unauthenticated session probe on /login is a 401 console line.
        if (m.type() === "error" && !/Failed to load resource: .*\b401\b/.test(m.text())) problems.push(`console: ${m.text()}`);
      });
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Login (logged out).
      await page.goto("/login");
      await settle(page);
      await expectHealthy(page, `login @${vp.name}`, problems);
      await page.screenshot({ path: path.join(OUT, `login-${vp.name}.png`) });

      await devLoginAdmin(page);
      const journeys = (await (await page.request.get(`${API}/journeys`)).json()) as { id: string; patientId: string }[];
      expect(journeys.length).toBeGreaterThan(0);
      const pages: [string, string][] = [
        ["command-centre", "/command-centre"],
        ["analytics", "/analytics"],
        ["leads", "/leads"],
        ["journey-detail", `/journeys/${journeys[0].id}`],
        ["patient-360", `/patients/${journeys[0].patientId}`],
        ["my-work", "/my-work"],
        ["appointments", "/appointments"],
        ["treatments", "/treatments"],
        ["campaigns", "/campaigns"],
        ["inbox", "/inbox"],
      ];
      for (const [name, url] of pages) {
        problems.length = 0;
        await page.goto(url);
        await settle(page);
        await expect(page, `${name} stayed on its route (no redirect to login)`).not.toHaveURL(/\/login/);
        await expectHealthy(page, `${name} @${vp.name}`, problems);
        await page.screenshot({ path: path.join(OUT, `${name}-${vp.name}.png`) });
      }
    });
  }
});

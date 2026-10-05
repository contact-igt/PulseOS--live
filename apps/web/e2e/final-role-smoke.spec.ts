import { test, expect, type Page } from "@playwright/test";
import { expectPeriod, periodOptionLabels, pickPeriod, setCustomRange } from "./support/period";
import { sql } from "./support/fixtures";

// Final gate: real sign-in as every role in both editions, the pages each role can reach, server-side permission
// answers at the API (never just hidden buttons), the CSRF origin policy, cross-hospital isolation, and the
// date controls at the five required widths. Read-only apart from signing in.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";

type Role = "superadmin" | "admin" | "coordinator" | "frontdesk" | "doctor";
const HOME: Record<Role, RegExp> = {
  superadmin: /\/command-centre/,
  admin: /\/command-centre/,
  coordinator: /\/my-work/,
  frontdesk: /\/front-desk/,
  doctor: /\/doctor-home/,
};
const ADMIN_PAGES = ["/command-centre", "/leads", "/my-work", "/appointments", "/front-desk", "/treatments", "/analytics", "/integrations", "/patients", "/journeys", "/settings"];

async function signIn(page: Page, prefix: "eyev1" | "eye", role: Role) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(`${prefix}.${role}@pulseos.local`);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(HOME[role]);
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: .*\b(401|403|404)\b/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

async function healthy(page: Page, label: string, problems: string[]) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${label}: horizontal overflow ${scrollWidth} > ${innerWidth}`).toBeLessThanOrEqual(innerWidth);
  await expect(page.locator("[data-nextjs-dialog]"), `${label}: runtime error overlay`).toHaveCount(0);
  expect(problems, `${label}: console/page errors`).toEqual([]);
}

const status = async (page: Page, path: string) => (await page.request.get(`${API}${path}`)).status();

test.describe("final role smoke", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  for (const [prefix, edition] of [["eyev1", "Ophthalmology V1"], ["eye", "Ophthalmology V2"]] as const) {
    for (const role of ["superadmin", "admin", "coordinator", "frontdesk", "doctor"] as Role[]) {
      test(`${edition} · ${role}: signs in to its home and the server answers by permission`, async ({ page }) => {
        const problems = watch(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await signIn(page, prefix, role);
        await healthy(page, `${edition} ${role} home`, problems);

        const admin = role === "superadmin" || role === "admin";
        // Server-side answers, not just hidden UI.
        expect(await status(page, "/integrations/hub"), "integration hub").toBe(admin ? 200 : 403);
        expect(await status(page, "/activity-log"), "activity log").toBe(admin ? 200 : 403);
        expect(await status(page, "/integrations/webhooks"), "outbound webhooks are Super Admin only").toBe(role === "superadmin" ? 200 : 403);
        const growth = prefix === "eye";
        expect(await status(page, "/dashboard/executive"), "hospital performance (growth edition, admin only)").toBe(admin && growth ? 200 : 403);
        expect(await status(page, "/analytics/campaigns"), "marketing analytics (growth edition, VIEW_MARKETING)").toBe(admin && growth ? 200 : 403);
        expect(await status(page, "/analytics/leads"), "core analytics").toBe(admin ? 200 : 403);

        // Malformed periods are refused, never silently "everything".
        if (admin && growth) expect(await status(page, "/dashboard/executive?range=custom"), "custom without dates").toBe(400);
        if (admin) expect(await status(page, "/activity-log?from=2026-09-10&to=2026-09-01"), "inverted range").toBe(400);

        if (admin) {
          for (const path of ADMIN_PAGES) {
            await page.goto(path);
            await expect(page, `${edition} ${role}: ${path} must not bounce`).toHaveURL(new RegExp(path.replace("/", "\\/")));
            await expect(page.locator("main").first()).toBeVisible();
            await page.waitForTimeout(600);
            await healthy(page, `${edition} ${role} ${path}`, problems);
          }
          // Growth pages: reachable in V2, sent home in V1.
          await page.goto("/campaigns");
          if (growth) await expect(page).toHaveURL(/\/campaigns/);
          else await expect(page).toHaveURL(/\/command-centre/);
        } else {
          // A role never reaches a page its own sidebar does not offer.
          await page.goto("/integrations");
          await expect(page).not.toHaveURL(/\/integrations/);
          await page.goto("/analytics");
          await expect(page).not.toHaveURL(/\/analytics/);
        }
      });
    }
  }

  test("V2 admin: Add Lead opens and closes, and a Journey Detail renders", async ({ page }) => {
    const problems = watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, "eye", "admin");
    await page.goto("/leads");
    await page.getByRole("button", { name: /\+ Add Lead/ }).first().click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const journeys = (await (await page.request.get(`${API}/journeys`)).json()) as { id: string }[];
    expect(journeys.length).toBeGreaterThan(0);
    await page.goto(`/journeys/${journeys[0]!.id}`);
    await expect(page.getByTestId("journey-detail").or(page.locator("main")).first()).toBeVisible();
    await page.waitForTimeout(600);
    await healthy(page, "journey detail", problems);
  });

  test("another hospital's records are invisible, and a cross-origin write is refused", async ({ page }) => {
    const v1Patient = sql("SELECT p.id FROM patients p JOIN tenants t ON t.id = p.tenant_id WHERE t.name LIKE '%V1%' LIMIT 1").split("\n")[0]!;
    expect(v1Patient).toMatch(/^[0-9a-f-]{36}$/);
    await signIn(page, "eye", "admin");
    expect(await status(page, `/patients/${v1Patient}/360`), "a V1 patient from a V2 session").toBe(404);

    const res = await page.request.post(`${API}/auth/logout`, { headers: { Origin: "https://evil.example" } });
    expect(res.status(), "foreign Origin on a state-changing request").toBe(403);
    expect(await status(page, "/auth/session"), "the session survived the refused request").toBe(200);
  });
});

test.describe("final responsive date-control check", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  const VIEWPORTS = [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ];

  for (const vp of VIEWPORTS) {
    test(`${vp.width}x${vp.height}: period controls fit, wrap cleanly and are touch-sized`, async ({ page }) => {
      const problems = watch(page);
      await page.setViewportSize(vp);
      await signIn(page, "eye", "admin");
      // The design system's touch widths are the phone widths (< 768px); tablet and desktop use the compact 32px controls.
      const touch = vp.width < 768;

      const fits = async (testId: string, label: string) => {
        const el = page.getByTestId(testId);
        await expect(el, `${label} visible`).toBeVisible();
        const box = (await el.boundingBox())!;
        expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${label} right edge inside ${vp.width}px`).toBeLessThanOrEqual(vp.width + 0.5);
        if (touch) expect(box.height, `${label} touch target`).toBeGreaterThanOrEqual(43.5);
      };

      // Command Centre: preset, custom dates, branch and service all reachable.
      await page.goto("/command-centre");
      await fits("cc-range", "Command Centre period");
      await pickPeriod(page, "cc", "custom");
      await fits("cc-range", "Command Centre period (custom)");
      await fits("cc-range-picker", "custom dates");
      await fits("filter-branch", "branch");
      await fits("filter-service", "service");
      await healthy(page, "command-centre custom", problems);

      // Core Analytics (Operations) and Marketing Analytics keep the same shared control.
      await page.goto("/analytics");
      await fits("report-range", "Core Analytics period");
      await healthy(page, "core analytics", problems);
      await page.goto("/analytics?section=marketing");
      await fits("analytics-range", "Marketing Analytics period");
      await healthy(page, "marketing analytics", problems);

      // Appointments: the period belongs to the history tabs only.
      await page.goto("/appointments?tab=no_show");
      await fits("appointments-period-range", "Appointments period");
      await healthy(page, "appointments", problems);

      // Leads: the enquiry-date preset stays in the main bar at every width (the other filters move into a sheet on phones).
      await page.goto("/leads");
      await page.waitForTimeout(600);
      await fits("leads-range", "Leads period");
      await healthy(page, "/leads", problems);

      // Settings and the Integration Hub: no overflow, no runtime errors.
      for (const path of ["/settings", "/integrations"]) {
        await page.goto(path);
        await page.waitForTimeout(600);
        await healthy(page, path, problems);
      }
    });
  }
});

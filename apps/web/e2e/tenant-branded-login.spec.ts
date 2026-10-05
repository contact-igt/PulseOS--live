import { test, expect, type Page } from "@playwright/test";
import { purgeSignupTenants, sql } from "./support/fixtures";

// ONE approved PulseOS tenant sign-in for every hospital: /login/<slug>, resolved on the server from the slug alone; only safe
// structured branding differs. These specs prove it is a shared system (not a Namokar one-off) and that its boundaries hold.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const RUN = `${Date.now()}`.slice(-6);

const open = async (page: Page, slug: string) => {
  const res = await page.goto(`/login/${slug}`);
  return res!.status();
};

test.describe("Tenant-branded login (shared PulseOS system)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");
  test.afterAll(() => {
    sql(`UPDATE tenant_login_configs SET logo_path = NULL WHERE tenant_id IN (SELECT id FROM tenants WHERE login_slug = 'eye-v1-demo')`);
    purgeSignupTenants();
  });

  test("1+2+3. Namokar and another seeded hospital use the SAME component with different words; no logo = typographic name", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await open(page, "namokar-v1")).toBe(200);
    await expect(page.getByTestId("tenant-login")).toHaveAttribute("data-workspace", "namokar-v1");
    await expect(page.getByTestId("login-lockup")).toContainText("PulseOS");
    await expect(page.getByTestId("login-client-name")).toHaveText("Namokar");
    await expect(page.getByTestId("login-headline")).toHaveText("Namokar Eye & Oculoplasty Centre");
    await expect(page.getByTestId("login-tagline")).toHaveText("Every enquiry, call, appointment and follow-up for your patients, in one place.");
    await expect(page.getByTestId("tenant-login-pilot")).toHaveText("V1 Demo");
    await expect(page.getByTestId("tenant-login-workspace")).toContainText(/Namokar[’']s PulseOS workspace/);
    await expect(page.getByTestId("login-support")).toHaveText("Need help? Contact your administrator.");
    await expect(page.getByTestId("login-client-logo")).toHaveCount(0);
    const namokarShape = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).filter((t) => t && t !== "tenant-login").sort().join(","));

    expect(await open(page, "eye-demo")).toBe(200);
    await expect(page.getByTestId("tenant-login")).toHaveAttribute("data-workspace", "eye-demo");
    await expect(page.getByTestId("login-client-name")).toHaveText("Eye Demo");
    await expect(page.getByTestId("login-headline")).toHaveText("PulseOS Ophthalmology Demo");
    await expect(page.getByTestId("login-tagline")).toHaveText("Every enquiry, call, appointment and follow-up in one place."); // the PulseOS default
    await expect(page.getByTestId("tenant-login-pilot")).toHaveText("Beta V2");
    await expect(page.getByTestId("tenant-login-workspace")).toContainText(/Eye Demo[’']s PulseOS workspace/);
    const eyeShape = await page.evaluate(() => [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).filter((t) => t && t !== "tenant-login").sort().join(","));
    expect(eyeShape, "the same structure, only the words differ").toBe(namokarShape);
  });

  test("4. an approved logo is shown untouched (not stretched, not recoloured), and removing it falls back to the name", async ({ page }) => {
    sql(`INSERT INTO tenant_login_configs (tenant_id, logo_path) SELECT id, '/brand/test-mark.svg' FROM tenants WHERE login_slug = 'eye-v1-demo' ON CONFLICT (tenant_id) DO UPDATE SET logo_path = '/brand/test-mark.svg'`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "eye-v1-demo");
    const img = page.getByTestId("login-client-logo").locator("img");
    await expect(img).toHaveAttribute("src", "/brand/test-mark.svg");
    await expect(img).toHaveAttribute("alt", "PulseOS Ophthalmology V1 Demo");
    await expect(page.getByTestId("login-client-name")).toHaveCount(0);
    const m = await img.evaluate((el: HTMLImageElement) => ({ nw: el.naturalWidth, nh: el.naturalHeight, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, filter: getComputedStyle(el).filter }));
    expect(m.nw).toBeGreaterThan(0); // the file really loads from our own origin
    expect(Math.abs(m.w / m.h - m.nw / m.nh), "aspect ratio preserved").toBeLessThan(0.05);
    expect(m.filter).toBe("none");
    // The logo never blocks signing in.
    await page.getByLabel("Email address").fill("eyev1.admin@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/command-centre/);
    sql(`UPDATE tenant_login_configs SET logo_path = NULL WHERE tenant_id IN (SELECT id FROM tenants WHERE login_slug = 'eye-v1-demo')`);
    await open(page, "eye-v1-demo");
    await expect(page.getByTestId("login-client-name")).toHaveText("Eye V1 Demo");
  });

  test("5. an unknown workspace is a generic 404 that reveals nothing", async ({ page }) => {
    for (const slug of ["invalid-company", "NAMOKAR-V1", "x", "namokar-not"]) {
      expect(await open(page, slug), slug).toBe(404);
      await expect(page.getByTestId("tenant-login-missing")).toContainText("Workspace not found");
      const text = (await page.locator("body").innerText()).toLowerCase();
      expect(text).not.toMatch(/namokar|tenant|database|stack|error:|uuid|[0-9a-f]{8}-[0-9a-f]{4}/);
      await expect(page.getByTestId("dev-login-block")).toHaveCount(0);
    }
  });

  test("6+7. a branded page cannot select another hospital and has no developer tools; the general page keeps them separate", async ({ page }) => {
    await open(page, "eye-demo");
    for (const hidden of ["dev-login-block", "dev-login-toggle", "signup-link", "signup-prompt"]) await expect(page.getByTestId(hidden)).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByText(/developer|create account|namokar|other hospital/i)).toHaveCount(0);
    // Another hospital's account is refused here (same answer as a wrong password).
    await page.getByLabel("Email address").fill("namokar.admin@pulseos.local");
    await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator('form [role="alert"]')).toHaveText("Incorrect email or password.");
    await expect(page).toHaveURL(/\/login\/eye-demo$/);
    // The internal development sign-in is a different route and is the only place Developer access exists.
    await page.goto("/login");
    await expect(page.getByTestId("dev-login-block")).toHaveCount(1);
  });

  test("8+9. Remember me sends the right boolean, and ON is a 7-day server session while OFF is the standard session", async ({ browser }) => {
    for (const remember of [true, false]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await open(page, "namokar-v1");
      const bodies: string[] = [];
      page.on("request", (r) => r.url().includes("/auth/login/tenant/namokar-v1") && bodies.push(r.postData() ?? ""));
      await page.getByLabel("Email address").fill("namokar.frontdesk@pulseos.local");
      await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
      if (remember) await page.getByTestId("remember-me").check();
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/front-desk/);
      expect(JSON.parse(bodies[0]!)).toEqual({ email: "namokar.frontdesk@pulseos.local", password: DEMO_PASSWORD, remember });
      const cookie = (await context.cookies()).find((c) => c.name === "pulseos_session")!;
      expect(cookie.httpOnly).toBe(true);
      if (remember) expect((cookie.expires - Date.now() / 1000) / 86400).toBeGreaterThan(6.9);
      else expect(cookie.expires).toBe(-1); // a session cookie
      // No credential or token is kept in browser storage.
      expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toMatch(/session|token|password|pulseos_session/i);
      await context.close();
    }
  });

  test("10. a hospital that signs up gets its branded login immediately, discovered by Developer access, with no engineering step", async ({ page }) => {
    const org = `E2E Signup Login ${RUN}`;
    const email = `e2e.login.${RUN}@example.test`;
    await page.goto("/login");
    const res = await page.evaluate(
      async ({ api, org, email }) => {
        const r = await fetch(`${api}/auth/signup`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ fullName: "E2E Owner", email, phone: "+91 98765 43210", password: "Correct-Horse-9", organizationName: org, industry: "Healthcare", organizationType: "Eye Hospital", department: "Ophthalmology", addressLine: "12 MG Road", city: "Bengaluru", state: "Karnataka", pinCode: "560038", country: "India", discoverySource: "Google", edition: "V1" }),
        });
        return { status: r.status, body: await r.json() };
      },
      { api: API, org, email },
    );
    expect(res.status).toBe(201);
    const loginPath = res.body.workspace.loginPath as string;
    expect(loginPath).toMatch(/^\/login\/e2e-signup-login-\d+$/);
    await page.context().clearCookies();
    expect(await open(page, loginPath.replace("/login/", ""))).toBe(200);
    await expect(page.getByTestId("login-headline")).toHaveText(org);
    await expect(page.getByTestId("tenant-login-pilot")).toHaveCount(0); // no badge unless the configuration says so
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Correct-Horse-9");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/command-centre/);
    // Developer access (development only) lists it by itself.
    const envs = await page.evaluate(async (api) => (await fetch(`${api}/auth/dev-login/environments`, { credentials: "include" })).json(), API);
    expect((envs as { label: string }[]).some((e) => e.label === org)).toBe(true);
  });

  test("11. the public configuration exposes display words only: no ids, secrets, users, edition or integrations", async ({ page }) => {
    await page.goto("/login");
    const body = await page.evaluate(async (api) => (await fetch(`${api}/auth/tenants/namokar-v1`)).json(), API);
    expect(Object.keys(body).sort()).toEqual(["badgeLabel", "displayName", "headline", "logoPath", "shortName", "slug", "supportText", "tagline"]);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|edition|BETA_|secret|token|password|connector|capabilit|@pulseos\.local/i);
    const missing = await page.evaluate(async (api) => { const r = await fetch(`${api}/auth/tenants/nobody-here`); return { s: r.status, b: await r.json() }; }, API);
    expect(missing).toEqual({ s: 404, b: { error: "not_found" } });
  });

  test("accessibility: real labels, a named and pressed password toggle, Remember me tied to its label, errors linked to the fields, keyboard order, Enter submits", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "namokar-v1");
    const email = page.getByLabel("Email address");
    const password = page.getByLabel("Password", { exact: true });
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    const toggle = page.getByRole("button", { name: "Show password" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await page.locator("label", { hasText: "Remember me" }).click(); // the label toggles the checkbox
    await expect(page.getByTestId("remember-me")).toBeChecked();
    await expect(page.getByTestId("remember-me")).toHaveAccessibleDescription(/7 days/);
    await expect(page.locator('svg[aria-hidden="true"]').first()).toBeAttached(); // decoration is hidden from assistive technology

    // Keyboard order: email -> password -> show/hide -> remember me -> Sign in; the focus ring is visible on a field.
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /password/i })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("remember-me")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeFocused();
    await email.focus();
    const ring = await email.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe("none");

    // A wrong password: the alert is linked to both fields, and Enter submitted the form.
    await email.fill("namokar.frontdesk@pulseos.local");
    await password.fill("wrong-password-1");
    await password.press("Enter");
    const alert = page.locator('form [role="alert"]');
    await expect(alert).toHaveText("Incorrect email or password.");
    const id = await alert.getAttribute("id");
    await expect(email).toHaveAttribute("aria-describedby", id!);
    await expect(password).toHaveAttribute("aria-describedby", id!);
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toBeFocused();
  });

  for (const w of [{ n: 1440, h: 900 }, { n: 1280, h: 800 }, { n: 1024, h: 768 }, { n: 768, h: 1024 }, { n: 390, h: 844 }]) {
    test(`12. responsive at ${w.n}: no horizontal overflow, the form is reachable, fields and button are practical touch targets`, async ({ page }) => {
      await page.setViewportSize({ width: w.n, height: w.h });
      for (const slug of ["namokar-v1", "namokar-v2", "eye-demo"]) {
        await open(page, slug);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${slug} overflows`).toBeLessThanOrEqual(0);
        for (const target of [page.getByLabel("Email address"), page.getByLabel("Password", { exact: true }), page.getByRole("button", { name: "Sign in" })]) {
          const box = (await target.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(43.5);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(w.n + 0.5);
        }
        if (w.n === 390) {
          // On a phone the form is on the first screen, under a compact blue hero.
          const signIn = (await page.getByRole("button", { name: "Sign in" }).boundingBox())!;
          expect(signIn.y + signIn.height, "Sign in is visible without scrolling").toBeLessThanOrEqual(844);
          const hero = (await page.getByTestId("login-visual").boundingBox())!;
          expect(hero.height).toBeLessThan(300);
        }
      }
    });
  }
});

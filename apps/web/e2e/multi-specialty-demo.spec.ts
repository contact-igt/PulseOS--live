import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

// Two fully separate demo tenants — Gynecology and Ophthalmology — reached
// through the Developer Login demo selector. Run twice in a row without
// reseeding: nothing here may depend on, or leave behind, state that breaks
// a second run (Add Lead is only opened, never submitted).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const SHOTS = path.resolve(__dirname, "../../../review-artifacts/multi-specialty-demo");

type Environment = "gynecology" | "ophthalmology";
type RoleKey = "HOSPITAL_ADMIN" | "DOCTOR" | "FRONT_DESK" | "PATIENT_COORDINATOR";

const HOME: Record<RoleKey, RegExp> = {
  HOSPITAL_ADMIN: /\/command-centre/,
  DOCTOR: /\/doctor-home/,
  FRONT_DESK: /\/front-desk/,
  PATIENT_COORDINATOR: /\/my-work/,
};

async function devLogin(page: Page, environment: Environment, role: RoleKey) {
  await page.goto("/login");
  await page.getByTestId("dev-login-toggle").click();
  await page.getByTestId(`dev-login-env-${environment}`).click();
  await page.getByTestId(`dev-login-role-${role}`).click();
  await page.waitForURL(HOME[role]);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

async function apiStatus(page: Page, url: string) {
  return (await page.request.get(`${API_URL}${url}`)).status();
}

async function apiJson<T>(page: Page, url: string): Promise<T> {
  const res = await page.request.get(`${API_URL}${url}`);
  expect(res.status(), url).toBe(200);
  return (await res.json()) as T;
}

test.describe("Multi-specialty demo environments", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("login shows the quiet Developer Login demo selector, with Sign in staying primary", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByTestId("dev-login-environments")).toHaveCount(0);
    await page.getByTestId("dev-login-toggle").click();
    await expect(page.getByTestId("dev-login-env-gynecology")).toBeVisible();
    await expect(page.getByTestId("dev-login-env-ophthalmology")).toBeVisible();
    await expect(page.getByTestId("dev-login-env-gynecology")).toHaveAttribute("aria-pressed", "true");
    for (const role of ["HOSPITAL_ADMIN", "DOCTOR", "FRONT_DESK", "PATIENT_COORDINATOR"]) {
      await expect(page.getByTestId(`dev-login-role-${role}`)).toBeVisible();
    }
    await page.getByTestId("dev-login-env-ophthalmology").click();
    await expect(page.getByTestId("dev-login-env-ophthalmology")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dev-login-env-gynecology")).toHaveAttribute("aria-pressed", "false");
    await shot(page, "01-login-demo-selector.png");
  });

  test("Developer Login controls keep a practical hit area at every width (44px+ on touch widths, 32px+ on desktop), stay inside the card, and are keyboard-operable with a visible focus ring", async ({ page }) => {
    const ids = ["dev-login-toggle", "dev-login-env-gynecology", "dev-login-env-ophthalmology", "dev-login-role-HOSPITAL_ADMIN", "dev-login-role-DOCTOR", "dev-login-role-FRONT_DESK", "dev-login-role-PATIENT_COORDINATOR"];
    const heights = async () => {
      const out: Record<string, number> = {};
      for (const id of ids) out[id] = (await page.getByTestId(id).boundingBox())!.height;
      return out;
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    for (const [id, h] of Object.entries(await heights())) expect(h, `${id} height on mobile`).toBeGreaterThanOrEqual(44);

    await page.setViewportSize({ width: 768, height: 1024 });
    for (const [id, h] of Object.entries(await heights())) expect(h, `${id} height on tablet`).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Desktop may be denser, but no control may shrink below a practical pointer target. There is deliberately NO upper
    // bound: a long label ("Staff · Patient Coordinator") wrapping to two lines is accessible, not a defect.
    for (const [id, h] of Object.entries(await heights())) expect(h, `${id} height on desktop`).toBeGreaterThanOrEqual(32);
    // Compact and intentional: every control stays on screen, with no horizontal page overflow, at every width.
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))); // let the layout settle
      for (const id of ids) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x, `${id} left edge at ${width}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${id} right edge at ${width}`).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `overflow at ${width}`).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // Keyboard: focus the toggle, collapse and re-open with Enter; an environment button takes focus and shows an outline.
    await page.getByTestId("dev-login-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("dev-login-environments")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("dev-login-environments")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("dev-login-env-gynecology")).toBeFocused();
    const outline = await page.getByTestId("dev-login-env-gynecology").evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("dev-login-env-ophthalmology")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("dev-login-role-DOCTOR")).toHaveAccessibleName("Doctor, Ophthalmology V2");
  });

  for (const environment of ["gynecology", "ophthalmology"] as const) {
    for (const role of ["HOSPITAL_ADMIN", "DOCTOR", "FRONT_DESK", "PATIENT_COORDINATOR"] as const) {
      test(`${environment}: ${role} lands on its role home in its own tenant`, async ({ page }) => {
        await devLogin(page, environment, role);
        const session = await apiJson<{ user: { role: string; email: string } }>(page, "/auth/session");
        expect(session.user.role).toBe(role);
        expect(session.user.email.startsWith(environment === "gynecology" ? "gyn." : "eye.")).toBe(true);
      });
    }
  }

  test("Ophthalmology admin walk-through: Command Centre → Leads → Cataract Patient 360 → appointments → treatments → campaigns", async ({ page }) => {
    await devLogin(page, "ophthalmology", "HOSPITAL_ADMIN");

    await expect(page.getByTestId("command-centre")).toBeVisible();
    await expect(page.getByText("Ramesh Hegde").first()).toBeVisible();
    await expect(page.getByText("Fertility")).toHaveCount(0);
    await shot(page, "03-ophthalmology-command-centre.png");

    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();
    for (const service of ["Cataract", "Oculoplasty", "Laser Vision Correction", "Squint"]) {
      await expect(page.locator('[data-testid^="lead-enquiry-"]').filter({ hasText: service }).first()).toBeVisible();
    }
    for (const gynTerm of ["Fertility", "Pregnancy Care", "IVF", "Priya Sharma"]) {
      await expect(page.getByText(gynTerm)).toHaveCount(0);
    }
    await shot(page, "04-ophthalmology-leads.png");

    // Open the cataract patient (right eye, surgery advised, decision pending).
    await page.goto(`/patients?q=${encodeURIComponent("Ramesh Hegde")}`);
    await page.locator("tbody tr", { hasText: "Ramesh Hegde" }).first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByText("Cataract").first()).toBeVisible();
    await expect(page.getByText("Recorded cataract status")).toBeVisible();
    await expect(page.getByText("Confirmed").first()).toBeVisible();
    await expect(page.getByText("Cataract Enquiry Line").first()).toBeVisible();
    await expect(page.getByText("Can I send my previous eye reports before the appointment?")).toBeVisible();
    await expect(page.getByText(/Cataract Surgery — Right Eye/).first()).toBeVisible();
    await shot(page, "06-cataract-patient-360.png");

    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();
    await expect(page.getByText("Anil Joshi").first()).toBeVisible();
    // The demo clock places same-day slots relative to the current time of day
    // (seed/demo/demo-clock.ts), so assert a time and the doctor on Anil Joshi's
    // row rather than a fixed clock time or the old single-line "time · doctor" text.
    const anilRow = page.locator('[data-testid^="appointment-row-"]', { hasText: "Anil Joshi" }).first();
    await expect(anilRow).toContainText(/\d{1,2}:\d{2}\s?(am|pm)/i);
    await expect(anilRow).toContainText("Dr. Rajiv Menon");
    await shot(page, "07-ophthalmology-appointments.png");

    await page.goto("/treatments");
    await expect(page.getByTestId("treatments-page")).toBeVisible();
    await expect(page.getByText("Cataract Surgery — Right Eye").first()).toBeVisible();
    // Scoped to the table: the new Procedure filter also lists "Ptosis Correction" as a (hidden) <option>.
    await expect(page.locator("tbody").getByText("Ptosis Correction").first()).toBeVisible();
    await shot(page, "08-ophthalmology-treatments.png");

    await page.goto("/campaigns");
    await expect(page.getByTestId("campaigns-page")).toBeVisible();
    await expect(page.getByText("Cataract Consultation — Google Search")).toBeVisible();
    await expect(page.getByText("LASIK / Laser Vision Correction — Google")).toBeVisible();
    await expect(page.getByText("Squint Consultation — Meta")).toBeVisible();
    await shot(page, "09-ophthalmology-campaigns.png");
  });

  test("each service's Patient 360 shows its own specialty fields (Oculoplasty, Laser, Squint)", async ({ page }) => {
    await devLogin(page, "ophthalmology", "HOSPITAL_ADMIN");
    const cases: { patient: string; labels: string[]; shotName: string }[] = [
      { patient: "Kavitha Prakash", labels: ["Oculoplasty", "Cosmetic / Functional", "Ptosis"], shotName: "10-oculoplasty-patient-360.png" },
      { patient: "Nisha Bhandari", labels: ["Laser Vision Correction", "Screening completed", "Pending evaluation"], shotName: "11-laser-patient-360.png" },
      { patient: "Prakash Naidu", labels: ["Squint", "Previous treatment", "Adult"], shotName: "12-squint-patient-360.png" },
    ];
    for (const c of cases) {
      await page.goto(`/patients?q=${encodeURIComponent(c.patient)}`);
      await page.locator("tbody tr", { hasText: c.patient }).first().click();
      await expect(page.getByTestId("patient-360")).toBeVisible();
      for (const label of c.labels) await expect(page.getByText(label).first()).toBeVisible();
      await shot(page, c.shotName);
    }
  });

  test("Ophthalmology Front Desk sees the eye waiting queue and no gynecology patients", async ({ page }) => {
    await devLogin(page, "ophthalmology", "FRONT_DESK");
    await expect(page.getByTestId("front-desk-page")).toBeVisible();
    await expect(page.getByText("Anil Joshi").first()).toBeVisible();
    for (const gynName of ["Priya Sharma", "Sneha Reddy", "Lakshmi Nair"]) await expect(page.getByText(gynName)).toHaveCount(0);
    await shot(page, "13-ophthalmology-front-desk.png");
  });

  test("Ophthalmology Doctor Home shows eye patients and no gynecology records", async ({ page }) => {
    await devLogin(page, "ophthalmology", "DOCTOR");
    await expect(page.getByTestId("doctor-home")).toBeVisible();
    await expect(page.getByText(/Cataract|Laser Vision Correction|Oculoplasty|Squint/).first()).toBeVisible();
    for (const gynName of ["Priya Sharma", "Fertility", "IVF"]) await expect(page.getByText(gynName)).toHaveCount(0);
    await shot(page, "14-ophthalmology-doctor-home.png");
  });

  test("Ophthalmology Coordinator My Work lists cataract, LASIK, ptosis and squint follow-ups", async ({ page }) => {
    await devLogin(page, "ophthalmology", "PATIENT_COORDINATOR");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await shot(page, "15-ophthalmology-my-work.png");
    const text = await page.getByTestId("my-work-page").innerText();
    for (const expected of ["Ramesh Hegde", "Nisha Bhandari", "Kavitha Prakash", "Aarav Deshpande"]) expect(text).toContain(expected);
    for (const gynName of ["Priya Sharma", "Sneha Reddy"]) expect(text).not.toContain(gynName);
  });

  test("Add Lead loads the fields of the tenant's own specialties — same drawer, different configuration", async ({ page }) => {
    await devLogin(page, "ophthalmology", "PATIENT_COORDINATOR");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    const select = page.getByTestId("lead-specialty-select");
    const eyeOptions = await select.locator("option").allTextContents();
    expect(eyeOptions).toEqual(expect.arrayContaining(["Cataract", "Oculoplasty", "Laser Vision Correction", "Squint"]));
    expect(eyeOptions.join("|")).not.toContain("Gynecology");

    await select.selectOption("CATARACT");
    await page.getByTestId("lead-additional-toggle").click(); // service fields live under "Additional details"
    await expect(page.getByLabel("Recorded cataract status")).toBeVisible();
    await expect(page.getByLabel("Surgery interest")).toBeVisible();
    await expect(page.getByLabel("Laterality").first()).toBeVisible();
    await expect(page.locator("#lead-journey-type")).toHaveValue("Cataract");
    await shot(page, "05-ophthalmology-add-lead-cataract.png");

    await select.selectOption("SQUINT");
    await expect(page.getByLabel("Squint type")).toBeVisible();
    await expect(page.getByLabel("Recorded cataract status")).toHaveCount(0);
    await expect(page.locator("#lead-journey-type")).toHaveValue("Squint");

    await page.context().clearCookies();
    await devLogin(page, "gynecology", "PATIENT_COORDINATOR");
    await page.goto("/leads");
    await page.getByTestId("add-lead-button").click();
    const gynOptions = await page.getByTestId("lead-specialty-select").locator("option").allTextContents();
    expect(gynOptions.join("|")).toContain("Gynecology");
    expect(gynOptions.join("|")).not.toContain("Cataract");
    await page.getByTestId("lead-specialty-select").selectOption("GYNECOLOGY");
    await page.getByTestId("lead-additional-toggle").click();
    await expect(page.getByLabel("Pregnancy status")).toBeVisible();
    await expect(page.getByLabel("Laterality")).toHaveCount(0);
  });

  test("Gynecology Command Centre stays gynecology and never shows eye services", async ({ page }) => {
    await devLogin(page, "gynecology", "HOSPITAL_ADMIN");
    await expect(page.getByTestId("command-centre")).toBeVisible();
    await expect(page.getByText("Priya Sharma").first()).toBeVisible();
    for (const eyeTerm of ["Cataract", "Oculoplasty", "Laser Vision Correction", "Squint", "Ramesh Hegde"]) {
      await expect(page.getByText(eyeTerm)).toHaveCount(0);
    }
    await shot(page, "02-gynecology-command-centre.png");
  });

  test("isolation: an Ophthalmology session cannot read a Gynecology patient by direct API access, and vice versa", async ({ page, context }) => {
    // Gynecology session — capture a known patient id.
    await devLogin(page, "gynecology", "HOSPITAL_ADMIN");
    const gynPatients = await apiJson<{ id: string; name: string }[]>(page, "/patients?search=Priya");
    const gynPatientId = gynPatients[0].id;
    expect(await apiStatus(page, `/patients/${gynPatientId}/360`)).toBe(200);

    // Switch to Ophthalmology — capture an eye patient id, then try the gyn id.
    await context.clearCookies();
    await devLogin(page, "ophthalmology", "HOSPITAL_ADMIN");
    expect(await apiStatus(page, `/patients/${gynPatientId}/360`)).toBe(404);
    const eyePatients = await apiJson<{ id: string }[]>(page, "/patients?search=Ramesh");
    const eyePatientId = eyePatients[0].id;
    expect(await apiStatus(page, `/patients/${eyePatientId}/360`)).toBe(200);

    // Reverse direction.
    await context.clearCookies();
    await devLogin(page, "gynecology", "HOSPITAL_ADMIN");
    expect(await apiStatus(page, `/patients/${eyePatientId}/360`)).toBe(404);
  });

  test("no horizontal overflow across both demo tenants at every required viewport", async ({ page, context }) => {
    test.setTimeout(240_000);
    const viewports = [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ];
    const admin = ["/command-centre", "/leads", "/patients", "/appointments", "/treatments", "/campaigns"];
    for (const environment of ["gynecology", "ophthalmology"] as const) {
      await context.clearCookies();
      await page.setViewportSize({ width: 1440, height: 900 });
      await devLogin(page, environment, "HOSPITAL_ADMIN");
      for (const vp of viewports) {
        await page.setViewportSize(vp);
        for (const route of admin) {
          await page.goto(route);
          await page.waitForLoadState("networkidle");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${environment} ${route} at ${vp.width}x${vp.height}`).toBeLessThanOrEqual(0);
        }
      }
      // Role-specific pages.
      for (const [role, route] of [["FRONT_DESK", "/front-desk"], ["PATIENT_COORDINATOR", "/my-work"], ["DOCTOR", "/doctor-home"]] as const) {
        await context.clearCookies();
        await page.setViewportSize({ width: 1440, height: 900 });
        await devLogin(page, environment, role);
        for (const vp of viewports) {
          await page.setViewportSize(vp);
          await page.goto(route);
          await page.waitForLoadState("networkidle");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow, `${environment} ${route} at ${vp.width}x${vp.height}`).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  test("critical Ophthalmology mobile views", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    await page.getByTestId("dev-login-toggle").click();
    await shot(page, "16-login-demo-selector-mobile.png");
    await devLogin(page, "ophthalmology", "HOSPITAL_ADMIN");
    await shot(page, "17-ophthalmology-command-centre-mobile.png");
    await page.goto(`/patients?q=${encodeURIComponent("Ramesh Hegde")}`);
    await page.locator("tbody tr", { hasText: "Ramesh Hegde" }).first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await shot(page, "18-cataract-patient-360-mobile.png");
  });
});

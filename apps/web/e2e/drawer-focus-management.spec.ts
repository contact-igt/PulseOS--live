import { test, expect, type Locator, type Page } from "@playwright/test";

// Functional-hardening prompt §6 / §27 — shared drawer focus management
// (useDialogFocus, packages/ui/src/useDialogFocus.ts): focus moves into the
// dialog on open, Tab is trapped within it, Escape closes it, and focus
// returns to whatever triggered it. Covers both consumers named in the
// prompt: the Inbox patient-context drawer and the Appointment Drawer.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

// `dialog.locator(":focus")` is unreliable across a Tab loop that passes
// through a `datetime-local` input (AddTaskDrawer's "Due", NewAppointment
// Drawer's "Date & time"): the browser moves between that input's internal
// day/month/year/hour/minute segments without firing anything the `:focus`
// CSS pseudo-class picks up on every step, even though
// `document.activeElement` correctly stays on the input the whole time.
// Checking DOM containment of `document.activeElement` directly sidesteps
// that and is what we actually care about — "focus never left the dialog".
async function focusIsInside(dialog: Locator): Promise<boolean> {
  return dialog.evaluate((el) => el.contains(document.activeElement));
}

test.describe("Drawer focus management", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");

  test("Inbox patient-context drawer traps focus and returns it to the trigger on Escape", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();

    const trigger = page.getByTestId("open-patient-context");
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Patient context" });
    await expect(dialog).toBeVisible();
    // Focus should have moved somewhere inside the dialog, not stayed on the trigger.
    await expect(dialog.locator(":focus")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("Appointment Drawer traps focus and returns it to the row that opened it, on Escape", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();

    const rowButton = page.locator('[data-testid^="appointment-row-"] button').first();
    await rowButton.focus();
    await rowButton.click();

    const drawer = page.getByTestId("appointment-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(":focus")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(rowButton).toBeFocused();
  });

  test("Appointment Drawer closes on backdrop click", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/appointments");
    await expect(page.getByTestId("appointments-page")).toBeVisible();

    await page.locator('[data-testid^="appointment-row-"] button').first().click();
    const drawer = page.getByTestId("appointment-drawer");
    await expect(drawer).toBeVisible();

    await page.getByRole("dialog", { name: "Appointment details" }).getByLabel("Close", { exact: true }).click();
    await expect(drawer).toBeHidden();
  });

  // Quick Create drawers (packages/ui/src/{AddLeadDrawer,AddPatientDrawer,
  // AddTaskDrawer,NewAppointmentDrawer}.tsx) previously had no focus trap at
  // all — just a bare Escape-only keydown listener. They now share
  // useDialogFocus, same as above. One test per drawer covers: focus enters
  // on open, Tab is trapped inside (never escapes to the page behind it),
  // Escape closes, and focus returns to the trigger that opened it.
  const quickCreateDrawers: {
    name: string;
    path: string;
    pageTestId: string;
    triggerTestId: string;
    drawerTestId: string;
    dialogLabel: string;
  }[] = [
    { name: "Add Lead", path: "/leads", pageTestId: "leads-page", triggerTestId: "add-lead-button", drawerTestId: "add-lead-drawer", dialogLabel: "Add Lead" },
    { name: "Add Patient", path: "/patients", pageTestId: "patients-page", triggerTestId: "add-patient-button", drawerTestId: "add-patient-drawer", dialogLabel: "Add Patient" },
    { name: "Add Task", path: "/my-work", pageTestId: "my-work-page", triggerTestId: "add-task-button", drawerTestId: "add-task-drawer", dialogLabel: "Add Task" },
    { name: "New Appointment", path: "/appointments", pageTestId: "appointments-page", triggerTestId: "new-appointment-button", drawerTestId: "new-appointment-drawer", dialogLabel: "New Appointment" },
  ];

  for (const d of quickCreateDrawers) {
    test(`${d.name} drawer traps focus, keeps Tab inside, and returns focus to the trigger on Escape`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await login(page, "gyn.admin@pulseos.local");
      await page.goto(d.path);
      await expect(page.getByTestId(d.pageTestId)).toBeVisible();

      const trigger = page.getByTestId(d.triggerTestId);
      await trigger.focus();
      await trigger.click();

      const dialog = page.getByRole("dialog", { name: d.dialogLabel });
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId(d.drawerTestId)).toBeVisible();
      // Focus should have moved somewhere inside the dialog, not stayed on the trigger.
      await expect(dialog.locator(":focus")).toHaveCount(1);

      // Tab repeatedly, well past the number of focusable fields in any of
      // these forms — if the trap were missing, focus would walk off into
      // the page behind the drawer (nav links, other buttons) well before
      // this loop ends.
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("Tab");
        expect(await focusIsInside(dialog)).toBe(true);
      }

      // Shift+Tab (backwards) must stay trapped too.
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Shift+Tab");
        expect(await focusIsInside(dialog)).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }

  test("Add Patient drawer keeps the Tab trap and Escape/focus-return working after a submit error", async ({ page }) => {
    // A validation/API error mid-flow re-renders the drawer with an extra
    // role="alert" node — this must not disturb the dialog ref the trap
    // depends on. AddPatientDrawer is the simplest of the four forms, so it
    // stands in for the class of bug (the trap logic is shared via
    // useDialogFocus, not reimplemented per drawer).
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");

    // Force the create-patient call to fail so the drawer's catch block
    // sets its error state and renders the role="alert" banner.
    await page.route("**/patients", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "forced failure for test" }) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/patients");
    await expect(page.getByTestId("patients-page")).toBeVisible();

    const trigger = page.getByTestId("add-patient-button");
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Add Patient" });
    await expect(dialog).toBeVisible();

    await page.locator("#patient-name").fill("E2E Focus Error Patient");
    await page.locator("#patient-phone").fill(`9${Math.floor(100000000 + Math.random() * 899999999)}`);
    const branchSelect = page.locator("#patient-branch");
    const firstBranchValue = await branchSelect.locator("option").nth(1).getAttribute("value");
    await branchSelect.selectOption(firstBranchValue!);

    await page.getByTestId("add-patient-submit").click();
    // Scoped to the dialog: Next.js's own route announcer is also
    // role="alert" and would make an unscoped query ambiguous.
    await expect(dialog.getByRole("alert")).toBeVisible();

    // Trap still holds with the error banner present.
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      expect(await focusIsInside(dialog)).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("Add Lead drawer traps focus and returns it to the trigger at mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/leads");
    await expect(page.getByTestId("leads-page")).toBeVisible();

    const trigger = page.getByTestId("add-lead-button");
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "Add Lead" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(":focus")).toHaveCount(1);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      expect(await focusIsInside(dialog)).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

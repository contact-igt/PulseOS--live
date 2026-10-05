import { test, expect, type Page } from "@playwright/test";
import { purgePatients, sql } from "./support/fixtures";

// M6.5 pre-M7 hardening, end to end: booking rules (past time, doctor double-booking), treatment completion date in
// the report, and Settings → Workflow Outcomes (locked system stages, configurable outcomes). Fictional fixtures only.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const TZ = "Asia/Kolkata";
const RUN = `${Date.now()}`.slice(-6);
const NAME = (n: string) => `E2E M65 ${n} ${RUN}`;

const dayInHospital = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
// A slot nobody else uses: a random day 20–60 days out, at a random quarter hour inside clinic hours.
const SLOT_DAY = dayInHospital(20 + (Number(RUN) % 40));
const SLOT_TIME = `${String(9 + (Number(RUN) % 8)).padStart(2, "0")}:${["00", "15", "30", "45"][Number(RUN) % 4]}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

async function createLead(page: Page, name: string): Promise<{ journeyId: string; patientId: string }> {
  return page.evaluate(
    async ({ api, name, phone }) => {
      const branches = ((await (await fetch(`${api}/lookups`, { credentials: "include" })).json()) as { branches: { id: string }[] }).branches;
      const res = await fetch(`${api}/leads`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone, specialtyKey: "CATARACT", branchId: branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} }),
      });
      return (await res.json()) as { journeyId: string; patientId: string };
    },
    { api: API, name, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}` },
  );
}

async function openBooking(page: Page, journeyId: string) {
  await page.goto(`/journeys/${journeyId}`);
  await page.getByTestId("journey-book-appointment").click();
  const drawer = page.getByTestId("new-appointment-drawer");
  await expect(drawer).toBeVisible();
  await drawer.locator("#appt-branch").selectOption({ index: 1 });
  return drawer;
}

test.describe("M6.5 — booking integrity", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  // The browser is NOT on hospital time: any browser-local date arithmetic in the booking path would surface here.
  test.use({ timezoneId: "America/Los_Angeles" });
  test.describe.configure({ mode: "serial" });
  test.afterAll(() => purgePatients("E2E M65 "));

  test("A + B: a past time is refused inline with the form kept; a future time books", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const { journeyId } = await createLead(page, NAME("Past"));
    const drawer = await openBooking(page, journeyId);
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    await drawer.locator("#appt-reason").fill("Review after surgery");

    await drawer.getByTestId("appt-time").fill("2020-01-01T10:00");
    await expect(drawer.getByTestId("appt-time-past")).toHaveText("Choose a future appointment time.");
    await expect(drawer.getByTestId("new-appointment-submit")).toBeDisabled();
    // Nothing typed was lost.
    await expect(drawer.locator("#appt-reason")).toHaveValue("Review after surgery");
    await expect(drawer.locator("#appt-doctor")).not.toHaveValue("");

    await drawer.getByTestId("appt-time").fill(`${dayInHospital(3)}T11:15`);
    await expect(drawer.getByTestId("appt-time-past")).toHaveCount(0);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();
    expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${journeyId}'`)).toBe("1");
    expect(sql(`SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM appointments WHERE journey_id = '${journeyId}'`)).toBe("11:15");
  });

  test("the server refuses a past booking even when the form is bypassed (nothing saved, a domain error, not a 500)", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const { journeyId, patientId } = await createLead(page, NAME("Bypass"));
    const res = await page.evaluate(
      async ({ api, journeyId, patientId }) => {
        const l = (await (await fetch(`${api}/lookups`, { credentials: "include" })).json()) as { branches: { id: string }[]; doctors: { id: string }[] };
        const r = await fetch(`${api}/appointments`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ patientId, journeyId, branchId: l.branches[0]!.id, doctorId: l.doctors[0]!.id, scheduledAt: new Date(Date.now() - 3_600_000).toISOString() }) });
        return { status: r.status, body: await r.json() };
      },
      { api: API, journeyId, patientId },
    );
    expect(res).toEqual({ status: 422, body: { error: "appointment_time_in_past" } });
    expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${journeyId}'`)).toBe("0");
  });

  test("C + D: the same doctor at the same time conflicts (form kept, no one named); another doctor works", async ({ page }) => {
    await login(page, "eyev1.frontdesk@pulseos.local");
    const first = await createLead(page, NAME("First"));
    const second = await createLead(page, NAME("Second"));

    let drawer = await openBooking(page, first.journeyId);
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    await drawer.getByTestId("appt-time").fill(`${SLOT_DAY}T${SLOT_TIME}`);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();
    // Stored as the hospital's wall time although the browser is in Los Angeles.
    expect(sql(`SELECT to_char(scheduled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') FROM appointments WHERE journey_id = '${first.journeyId}'`)).toBe(`${SLOT_DAY} ${SLOT_TIME}`);

    const msg = "This doctor already has another appointment at this time. Choose a different time or doctor.";
    // Phase 1 — the advisory check warns as soon as doctor and time are picked, before anything is submitted.
    drawer = await openBooking(page, second.journeyId);
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    await drawer.getByTestId("appt-time").fill(`${SLOT_DAY}T${SLOT_TIME}`);
    await expect(drawer.getByTestId("new-appointment-error")).toHaveText(msg);
    // Switching doctor drops the warning immediately; switching back brings the check's answer back.
    await drawer.locator("#appt-doctor").selectOption({ index: 2 });
    await expect(drawer.getByTestId("new-appointment-error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();

    // Phase 2 — the SERVER refuses on its own: the advisory check is forced to say "free", so only the booking can object.
    await page.route("**/appointments/slot-check*", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "http://localhost:3310", "access-control-allow-credentials": "true" }, body: JSON.stringify({ available: true, inPast: false }) }));
    drawer = await openBooking(page, second.journeyId);
    await drawer.locator("#appt-doctor").selectOption({ index: 1 });
    await drawer.locator("#appt-reason").fill("Second patient, same slot");
    await drawer.getByTestId("appt-time").fill(`${SLOT_DAY}T${SLOT_TIME}`);
    await expect(drawer.getByTestId("new-appointment-error")).toHaveCount(0); // nothing warned: the server must be the one to refuse
    const refused = page.waitForResponse((r) => r.url().endsWith("/appointments") && r.request().method() === "POST");
    await drawer.getByTestId("new-appointment-submit").click();
    expect((await refused).status()).toBe(409);
    await expect(drawer.getByTestId("new-appointment-error")).toHaveText(msg);
    expect(sql(`SELECT count(*) FROM appointments WHERE journey_id = '${second.journeyId}'`)).toBe("0"); // after the response, not before
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("#appt-reason")).toHaveValue("Second patient, same slot"); // everything typed stays
    await expect(drawer).not.toContainText(NAME("First")); // the other patient is never named
    await expect(drawer).not.toContainText("409");
    await page.unroute("**/appointments/slot-check*");

    // Another doctor, same time: free.
    await drawer.locator("#appt-doctor").selectOption({ index: 2 });
    await expect(drawer.getByTestId("new-appointment-error")).toHaveCount(0);
    await drawer.getByTestId("new-appointment-submit").click();
    await expect(drawer).not.toBeVisible();
    expect(sql(`SELECT count(DISTINCT resource_id) FROM appointments WHERE journey_id IN ('${first.journeyId}','${second.journeyId}')`)).toBe("2");
  });
});

test.describe("M6.5 — completed procedures follow the completion date", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.afterAll(() => purgePatients("E2E M65 "));

  test("E: completing a treatment shows it as 'Completed on' today in Treatments and adds one to today's Operations report", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    const reportNow = async () => (await (await page.request.get(`${API}/reports/operations?range=today`)).json()) as { kpis: { proceduresCompleted: number; proceduresCompletedUndated: number } };
    const before = (await reportNow()).kpis.proceduresCompleted;

    const { journeyId } = await createLead(page, NAME("Procedure"));
    const treatmentId = await page.evaluate(
      async ({ api, journeyId }) => {
        const lookups = (await (await fetch(`${api}/lookups`, { credentials: "include" })).json()) as { branches: { id: string }[] };
        const [catalog, resources] = await Promise.all([
          fetch(`${api}/treatment-catalog`, { credentials: "include" }).then((r) => r.json() as Promise<{ id: string; key: string }[]>),
          fetch(`${api}/resources`, { credentials: "include" }).then((r) => r.json() as Promise<{ id: string }[]>),
        ]);
        const sched = await fetch(`${api}/journeys/${journeyId}/surgery`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" },
          body: JSON.stringify({ treatmentDefinitionId: catalog.find((d) => d.key === "CATARACT_SURGERY")!.id, scheduledAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), resourceId: resources[0]!.id, branchId: lookups.branches[0]!.id }),
        });
        const { treatmentId } = (await sched.json()) as { treatmentId: string };
        await fetch(`${api}/treatments/${treatmentId}/status`, { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "COMPLETED" }) });
        return treatmentId;
      },
      { api: API, journeyId },
    );

    // Three different dates for one procedure: scheduled for (+9 days), completed on (now), payment (now, a separate fact).
    expect(sql(`SELECT (completed_at IS NOT NULL)::text || '|' || (planned_date > now() + interval '8 days')::text FROM treatment_opportunities WHERE id = '${treatmentId}'`)).toBe("true|true");

    await page.goto("/treatments?state=COMPLETED");
    const line = page.getByTestId(`treatment-date-${treatmentId}`);
    await expect(line).toBeVisible();
    await expect(line).toContainText("Completed on");
    await expect(line).not.toContainText("Scheduled for");

    expect((await reportNow()).kpis.proceduresCompleted).toBe(before + 1);
    await page.goto("/command-centre?cc=report&rRange=today");
    await expect(page.getByTestId("report-kpi-procedures-done")).toContainText(new RegExp(`(^|\\D)${before + 1}(\\D|$)`));
  });
});

test.describe("M6.5 — system stages and configurable outcomes", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set");
  test.describe.configure({ mode: "serial" });
  const KEYS = ["a", "b"].map((x) => `e2e_m65_${x}_${RUN}`);
  test.afterAll(() => {
    sql(`UPDATE journeys SET last_outcome_id = NULL WHERE last_outcome_id IN (SELECT id FROM crm_outcomes WHERE key LIKE 'e2e_m65_%'); DELETE FROM crm_outcomes WHERE key LIKE 'e2e_m65_%';`);
  });

  test("F: every system stage is locked and named; outcomes are added, dragged and edited under Contacted", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=outcomes");
    await expect(page.getByTestId("outcomes-section")).toBeVisible();

    // All nine system stages, locked, in lifecycle order; only Contacted and Lost take outcomes.
    const stages = ["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "lost"];
    await expect.poll(() => page.locator('[data-testid^="stage-locked-"]').count()).toBe(9);
    await expect.poll(() => page.locator('li[data-testid^="stage-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("stage-", "")))).toEqual(stages);
    for (const s of stages) await expect(page.getByTestId(`stage-locked-${s}`)).toContainText("System stage");
    await expect(page.getByTestId("stage-booked")).not.toContainText("Add outcome");
    await expect(page.getByTestId("stage-booked").getByRole("button")).toHaveCount(0); // nothing to rename, move or delete
    await expect(page.getByTestId("stage-contacted")).toContainText("Interested");
    await expect(page.getByTestId("stage-lost")).toContainText("Not interested");

    // Add two outcomes under Contacted from the stage's own button.
    for (const [i, key] of KEYS.entries()) {
      await page.getByTestId("outcomes-add-contacted").click();
      await page.getByTestId("outcome-label").fill(`E2E M65 ${"AB"[i]} ${RUN}`);
      await expect(page.getByTestId("outcome-stage")).toHaveValue("contacted");
      await page.getByTestId("outcome-save").click();
      await expect(page.getByTestId(`outcome-row-${key}`)).toBeVisible();
    }
    const order = () => page.locator('[data-testid="outcome-group-contacted"] [data-testid^="outcome-row-e2e_m65_"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")!.replace("outcome-row-", "")));
    await expect.poll(order).toEqual(KEYS);

    // Drag B above A by its grip.
    const grip = page.getByTestId(`outcome-drag-${KEYS[1]}`);
    const target = page.getByTestId(`outcome-row-${KEYS[0]}`);
    await grip.scrollIntoViewIfNeeded();
    const g = (await grip.boundingBox())!;
    const t = (await target.boundingBox())!;
    const saved = page.waitForResponse((r) => r.url().includes("/crm/outcomes/reorder") && r.ok());
    await grip.hover();
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 12, { steps: 6 });
    await page.mouse.move(t.x + 40, t.y + 4, { steps: 12 });
    await page.mouse.up();
    await saved;
    await expect.poll(order).toEqual([KEYS[1], KEYS[0]]);
    expect(sql(`SELECT string_agg(key, ',' ORDER BY sort_order) FROM crm_outcomes WHERE key LIKE 'e2e_m65_%_${RUN}'`)).toBe(`${KEYS[1]},${KEYS[0]}`);
    await page.reload();
    await expect.poll(order).toEqual([KEYS[1], KEYS[0]]);

    // Edit, and archive: the row keeps its words and stays visible under "Show archived".
    await page.getByTestId(`outcome-edit-${KEYS[0]}`).click();
    await page.getByTestId("outcome-label").fill(`E2E M65 A renamed ${RUN}`);
    await page.getByTestId("outcome-save").click();
    await expect(page.getByTestId(`outcome-row-${KEYS[0]}`)).toContainText("renamed");
    await page.getByTestId(`outcome-archive-${KEYS[0]}`).click();
    await expect(page.getByTestId(`outcome-row-${KEYS[0]}`)).toHaveCount(0);
    await page.getByTestId("outcomes-show-archived").check();
    await expect(page.getByTestId(`outcome-row-${KEYS[0]}`)).toContainText("Archived");
  });

  test("F2: at 390px the stages and outcomes are usable (handle + arrows, 44px targets) and nothing overflows", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=outcomes");
    await expect(page.getByTestId("stage-contacted")).toBeVisible();
    await expect(page.getByTestId("stage-locked-booked")).toBeVisible();
    // The handle is the primary control on every screen; the quiet arrows stay on touch too. Each is a real 44px target.
    await expect(page.locator('[data-testid^="outcome-drag-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="outcome-move-down-"]').first()).toBeVisible();
    for (const id of await page.locator('[data-testid^="outcome-move-down-"], [data-testid^="outcome-drag-"]').evaluateAll((els) => els.slice(0, 4).map((e) => e.getAttribute("data-testid")!))) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.width, `${id} width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${id} height`).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

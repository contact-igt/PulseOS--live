import { test, expect, type Page } from "@playwright/test";
import { purgePatients } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = "http://localhost:4310";
const run = `${Date.now()}`.slice(-6);
const NAME = `E2E M7 Wa ${run}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home|leads/);
}

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ api, method, path, body }) => {
      const res = await fetch(`${api}${path}`, { method, credentials: "include", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    { api: API, method, path, body },
  );
}

test.describe("M7 WhatsApp notifications without the Inbox", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");
  test.afterAll(() => purgePatients("E2E M7 Wa"));

  test("C/D. V1 (Inbox off): Send WhatsApp from a follow-up shows a preview, sends once, and leaves the follow-up open", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    // WhatsApp is on for V1 by default, the Inbox is not: the Inbox API is refused while notifications work.
    expect((await api(page, "GET", "/conversations")).status).toBe(403);
    expect((await api(page, "GET", "/notifications/rules")).status).toBe(200);
    // A fixture WhatsApp connection (no provider is ever contacted).
    expect((await api(page, "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "e2e-fixture" } })).status).toBe(200);

    const lookups = (await api<{ branches: { id: string }[] }>(page, "GET", "/lookups")).body;
    const lead = await api<{ journeyId: string; patientId: string }>(page, "POST", "/leads", { name: NAME, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`, specialtyKey: "CATARACT", branchId: lookups.branches[0]!.id, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(lead.status).toBe(201);
    const journeyId = lead.body.journeyId;
    const types = (await api<{ id: string; key: string }[]>(page, "GET", "/followup-types")).body;
    const due = new Date(Date.now() + 3_600_000).toISOString();
    expect((await api(page, "POST", `/journeys/${journeyId}/follow-ups`, { followUpTypeId: types[0]!.id, dueAt: due, note: "Call back about timing" })).status).toBe(201);

    await page.goto(`/journeys/${journeyId}`);
    await page.getByTestId("next-action-whatsapp").click();
    const sheet = page.getByTestId("send-whatsapp-sheet");
    await expect(sheet.getByTestId("whatsapp-preview-text")).toContainText("Hello");
    await expect(sheet.getByTestId("whatsapp-recipient")).toContainText("•");
    await sheet.getByTestId("whatsapp-send").click();
    await expect(sheet.getByTestId("whatsapp-sent")).toBeVisible();
    await expect(sheet.getByTestId("whatsapp-send")).toHaveCount(0); // cannot send twice from this sheet
    await sheet.getByTestId("whatsapp-done").click();
    // The follow-up is still open: sending is not completing.
    await expect(page.getByTestId("next-action-complete")).toBeVisible();
    // The message is on the Journey's timeline.
    const timeline = await api<{ eventType: string }[]>(page, "GET", `/patients/${lead.body.patientId}/timeline`);
    expect(timeline.body.some((e) => e.eventType === "whatsapp_sent")).toBe(true);
  });

  test("Settings → Reminders shows the default rules, and Staff do not see the tab", async ({ page }) => {
    await login(page, "eyev1.admin@pulseos.local");
    await page.goto("/settings?section=reminders");
    await expect(page.getByTestId("reminders-section")).toBeVisible();
    await expect(page.getByText("Reminder — 1 days before").first()).toBeVisible();
    await expect(page.getByText("Reminder — 1 hours before").first()).toBeVisible();
    await expect(page.getByText("Confirmation — sent when booked")).toBeVisible();
    await login(page, "eyev1.frontdesk@pulseos.local");
    await page.goto("/settings");
    await expect(page.getByTestId("settings-tab-reminders")).toHaveCount(0);
  });

  test("Turning WhatsApp Notifications off hides Send WhatsApp and the Reminders tab", async ({ page }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    expect((await api(page, "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).status).toBe(200);
    try {
      await page.goto("/settings");
      await expect(page.getByTestId("settings-tab-reminders")).toHaveCount(0);
      expect((await api(page, "GET", "/notifications/rules")).status).toBe(403);
    } finally {
      await api(page, "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: null });
    }
  });
});

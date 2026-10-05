import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { purgePatients } from "./support/fixtures";
import path from "path";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";
const ARTIFACTS_DIR = path.resolve(__dirname, "../../../review-artifacts");

function sign(rawBody: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex");
}

async function login(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home/);
}

test.describe("Communication connectors checkpoint (Group Y)", () => {
  // Fictional "E2E Fixture Patient…" patients created by this spec are removed afterwards (repeatable without a reseed).
  test.afterAll(() => purgePatients("E2E Fixture Patient"));
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  test("FLOW 1/2/3 end-to-end against fixture providers + all 8 required screenshots", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    await expect(page.getByTestId("command-centre")).toBeVisible();

    // ---- Integrations UI ----
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "01-integrations.png"), fullPage: true });

    const connectorsRes = await request.get(`${API_BASE}/connectors`, { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } });
    const connectorList = await connectorsRes.json();
    const whatsapp = connectorList.find((c: { provider: string }) => c.provider === "whatsapp_meta_cloud");
    const runo = connectorList.find((c: { provider: string }) => c.provider === "runo");
    expect(whatsapp?.status).toBe("CONNECTED");
    expect(runo?.status).toBe("CONNECTED");

    await page.getByTestId(`connector-row-whatsapp_meta_cloud`).click();
    await expect(page.getByText("Secrets configured")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "02-whatsapp-connector.png"), fullPage: true });

    await page.getByTestId(`connector-row-runo`).click();
    await expect(page.getByText("Secrets configured")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "03-telephony-connector.png"), fullPage: true });

    // ---- FLOW 1: WhatsApp — verified fixture webhook -> Conversation -> Inbox -> human reply -> Timeline ----
    const wamid = `wamid.E2E_${Date.now()}`;
    const from = `9198${String(Date.now()).slice(-7)}`;
    const messagePayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "FIXTURE_WABA_ID",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "FIXTURE_PHONE_NUMBER_ID" },
            contacts: [{ wa_id: from, profile: { name: "E2E Fixture Patient" } }],
            messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi, I want to ask about your fertility program." } }],
          },
        }],
      }],
    };
    const rawBody = JSON.stringify(messagePayload);
    const webhookRes = await request.post(`${API_BASE}/webhooks/whatsapp/${whatsapp.id}`, {
      data: rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(rawBody) },
    });
    expect(webhookRes.ok()).toBeTruthy();

    // ---- FLOW 2: Runo — fixture webhook -> Call persisted -> Patient resolved -> Timeline -> Next Action ----
    const runoRes = await request.post(`${API_BASE}/webhooks/runo/${runo.id}`, {
      data: {
        call_id: `e2e-call-${Date.now()}`,
        phone_number: from,
        customer_name: "E2E Fixture Patient",
        agent_name: "Front Desk Agent",
        direction: "inbound",
        status: "completed",
        duration_seconds: 95,
        recording_url: "https://fixture.example/e2e-recording.mp3",
        disposition: "CALL_BACK_LATER",
        started_at: new Date(Date.now() - 100_000).toISOString(),
        ended_at: new Date().toISOString(),
      },
      headers: { "x-api-key": "pulseos-fixture-runo-secret" },
    });
    expect(runoRes.ok()).toBeTruthy();

    // ---- FLOW 3: Ownership — coordinator claims the new conversation ----
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await expect(page.getByText("E2E Fixture Patient").first()).toBeVisible({ timeout: 10_000 });
    await page.getByText("E2E Fixture Patient").first().click();
    const conversationDetail = page.locator("section");
    await expect(conversationDetail.getByText("Needs attention")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "04-inbox-live-conversation.png"), fullPage: true });

    await page.getByTestId("claim-conversation").click();
    await expect(conversationDetail.getByText("You're handling this")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "05-inbox-human-active.png"), fullPage: true });

    // Human reply — no fake AI response.
    await page.getByPlaceholder("Type a message…").fill("Thanks for reaching out — happy to help with that.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(conversationDetail.getByText("Thanks for reaching out — happy to help")).toBeVisible();

    // ---- Patient 360 communication Timeline ----
    await page.goto("/patients");
    await page.getByTestId("patient-search").fill("E2E Fixture Patient");
    await page.getByText("E2E Fixture Patient").first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    // One line per conversation session (not per message), since the idle-window session change.
    await expect(page.getByText(/WhatsApp conversation · \d+ message/).first()).toBeVisible();
    await expect(page.getByText(/Call completed/)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "06-patient-360-communication-timeline.png"), fullPage: true });

    // ---- Tablet screenshots ----
    await page.setViewportSize({ width: 768, height: 1024 });

    // Integrations is Hospital-Admin/Super-Admin only (VIEW_INTEGRATIONS —
    // Coordinator never had it; the role-aware route guard added later just
    // started enforcing what the permission matrix already said, so staying
    // logged in as coordinator here now correctly redirects away before the
    // page renders). Re-login as admin for this one screenshot rather than
    // pretend a role that can't reach the page took it.
    await login(page, "gyn.admin@pulseos.local");
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "07-integrations-tablet.png"), fullPage: true });

    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "08-inbox-tablet.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});

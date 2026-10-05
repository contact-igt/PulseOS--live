import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import path from "path";
import { purgePatients, sql } from "./support/fixtures";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";
const APP_SECRET = "FIXTURE_TEST_APP_SECRET";
const RUNO_SECRET = "pulseos-fixture-runo-secret";
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

// Wave 3 proof, end-to-end through the real browser: (1) a hospital with
// multiple WhatsApp numbers gets each conversation correctly attributed to
// the right line, not just at the API layer but visibly in Integrations,
// Inbox, and Patient 360; (2) a missed call creates a real, reason-tagged
// follow-up task, and the My Work reason-pill filter (added this pass)
// correctly surfaces it.
test.describe("Wave 3 — multi-endpoint attribution + telecaller reason filters (Group Omnichannel)", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD must be set to run this suite");

  // Fictional fixtures this spec creates in the live demo DB — patients (with their
  // conversations, calls, tasks) and the extra WhatsApp line — are removed afterwards,
  // so the suite is repeatable without a reseed.
  const LINE_LABEL = `E2E Fertility Line ${Date.now()}`;
  test.afterAll(() => {
    purgePatients("Wave3 E2E ");
    sql(`DELETE FROM communication_endpoints WHERE display_label LIKE 'E2E Fertility Line%'`);
  });

  test("a second configured WhatsApp line is attributed correctly across Integrations, Inbox, and Patient 360", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");

    const cookieHeader = (cookies: { name: string; value: string }[]) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const connectorsRes = await request.get(`${API_BASE}/connectors`, { headers: { cookie: cookieHeader(await page.context().cookies()) } });
    const connectorList = await connectorsRes.json();
    const whatsapp = connectorList.find((c: { provider: string }) => c.provider === "whatsapp_meta_cloud");
    expect(whatsapp).toBeTruthy();

    // ---- Configure a second hospital line via the real Integrations UI, not the API directly ----
    const providerRef = `E2E_PNI_${Date.now()}`;
    const label = LINE_LABEL;
    await page.goto("/integrations?view=connectors");
    await expect(page.getByTestId("integrations-page")).toBeVisible();
    await page.getByTestId(`connector-row-${whatsapp.provider}`).click();
    await page.getByTestId("add-endpoint-button").click();
    await page.getByTestId("new-endpoint-type").selectOption("WHATSAPP");
    await page.getByTestId("new-endpoint-public-number").fill("+919876500222");
    await page.getByTestId("new-endpoint-provider-ref").fill(providerRef);
    await page.getByTestId("new-endpoint-display-label").fill(label);
    await page.getByTestId("save-endpoint-button").click();
    await expect(page.getByText(label)).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-01-integrations-endpoint-added.png"), fullPage: true });

    // ---- A real inbound message on that exact line, via the real webhook route ----
    const wamid = `wamid.WAVE3_E2E_${Date.now()}`;
    const from = `9198${String(Date.now()).slice(-7)}`;
    const patientName = "Wave3 E2E Fertility Patient";
    const messagePayload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "E2E_WABA_ID",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: providerRef },
            contacts: [{ wa_id: from, profile: { name: patientName } }],
            messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Enquiring about the fertility line specifically." } }],
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

    // ---- Inbox: the conversation shows the resolved line, and the line filter isolates it ----
    await page.goto("/inbox");
    await expect(page.getByTestId("inbox-page")).toBeVisible();
    await expect(page.getByText(patientName).first()).toBeVisible({ timeout: 10_000 });
    await page.getByText(patientName).first().click();
    await expect(page.getByTestId("conversation-endpoint-label")).toHaveText(`· ${label}`);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-02-inbox-endpoint-label.png"), fullPage: true });

    await page.getByTestId("endpoint-filter-select").selectOption({ label });
    await expect(page.getByText(patientName).first()).toBeVisible();
    // Every other seeded conversation is on a different (or unresolved) line — the filter must hide them.
    await expect(page.getByText("Pooja Agarwal")).not.toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-03-inbox-line-filtered.png"), fullPage: true });
    await page.getByTestId("endpoint-filter-select").selectOption({ label: "All lines" });

    // ---- Patient 360: the same endpoint label appears on the unified Communication timeline ----
    await page.goto("/patients");
    await page.getByTestId("patient-search").fill(patientName);
    await page.getByText(patientName).first().click();
    await expect(page.getByTestId("patient-360")).toBeVisible();
    await expect(page.getByText(new RegExp(`Communication.*${label}`))).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-04-patient-360-endpoint-label.png"), fullPage: true });
  });

  test("a missed call creates a reason-tagged follow-up task, and the My Work reason pills correctly filter to it", async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, "gyn.admin@pulseos.local");
    const cookieHeader = (cookies: { name: string; value: string }[]) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const connectorsRes = await request.get(`${API_BASE}/connectors`, { headers: { cookie: cookieHeader(await page.context().cookies()) } });
    const connectorList = await connectorsRes.json();
    const runo = connectorList.find((c: { provider: string }) => c.provider === "runo");
    expect(runo).toBeTruthy();

    const phone = `9198${String(Date.now()).slice(-7)}`;
    const patientName = "Wave3 E2E Missed Caller";
    const runoRes = await request.post(`${API_BASE}/webhooks/runo/${runo.id}`, {
      data: {
        call_id: `wave3-e2e-missed-${Date.now()}`,
        phone_number: phone,
        customer_name: patientName,
        agent_name: "Front Desk Agent",
        direction: "inbound",
        status: "missed",
        duration_seconds: 0,
        recording_url: null,
        disposition: null,
        started_at: new Date(Date.now() - 5_000).toISOString(),
        ended_at: new Date().toISOString(),
      },
      headers: { "x-api-key": RUNO_SECRET },
    });
    expect(runoRes.ok()).toBeTruthy();

    // Backend proof: the missed call really did create a CALLBACK task
    // tagged reason "missed_follow_up" (not silently nothing, the gap this
    // whole pass closed).
    const patientsRes = await request.get(`${API_BASE}/patients?search=${encodeURIComponent(patientName)}`, { headers: { cookie: cookieHeader(await page.context().cookies()) } });
    const patients = await patientsRes.json();
    expect(patients.length).toBeGreaterThan(0);
    const tasksRes = await request.get(`${API_BASE}/tasks?patientId=${patients[0].id}`, { headers: { cookie: cookieHeader(await page.context().cookies()) } });
    const tasks = await tasksRes.json();
    const missedTask = tasks.find((t: { type: string; reason: string }) => t.type === "CALLBACK" && t.reason === "missed_follow_up");
    expect(missedTask).toBeTruthy();

    // UI proof: the reason-pill mechanism on My Work (this pass's own
    // build) correctly isolates missed-call follow-ups from every other
    // reason, using the coordinator's real seeded workload.
    await login(page, "gyn.coordinator@pulseos.local");
    await page.goto("/my-work");
    await expect(page.getByTestId("my-work-page")).toBeVisible();
    await page.getByTestId("my-work-reason-missed_follow_up").click();
    await expect(page.getByText("Missed follow-up").first()).toBeVisible();
    await expect(page.getByText("Treatment decision pending")).not.toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-05-my-work-missed-calls-pill.png"), fullPage: true });

    await page.getByTestId("my-work-reason-follow_up").click();
    await expect(page.getByText("Treatment decision pending").first()).toBeVisible();
    await expect(page.getByText("Missed follow-up")).not.toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "wave3-06-my-work-followups-pill.png"), fullPage: true });
  });
});

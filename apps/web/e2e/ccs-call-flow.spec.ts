import { test, expect, type Page } from "@playwright/test";

// A CCS call travelling into the real workflow, end to end, on a LOCAL stack with a disposable database. Synthetic data only:
// map an IVR line to a source and a CCS agent to a team member (Super Admin), deliver a call the way CCS would, then see it in
// Recent calls and open it. Needs the CCS key saved by e2e/ccs-credentials.spec.ts (run that first on a fresh database).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "";
const API = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:4310";
const API_KEY = "synthetic-e2e-api-key-7c1d";
const RUN = Date.now().toString(36);
const LINE_NUMBER = `080${String(Math.floor(10000000 + Math.random() * 89999999)).slice(0, 8)}`;
const CALLER = `98${String(Math.floor(10000000 + Math.random() * 89999999))}`;

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/command-centre|front-desk|my-work|doctor-home|leads/);
}

test.describe("CCS call into the patient journey", () => {
  test.skip(!DEMO_PASSWORD, "DEMO_PASSWORD not set");
  test.describe.configure({ mode: "serial" });

  test("Super Admin maps a line and an agent, a call arrives, and it is readable and openable", async ({ page, request }) => {
    await login(page, "eyev1.superadmin@pulseos.local");
    await page.goto("/integrations?open=ccs_ivr");
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // --- Lines & team (Super Admin only)
    await sheet.getByTestId("detail-tab-lines").click();
    await sheet.getByLabel("Line name", { exact: true }).fill(`Camp line ${RUN}`);
    await sheet.getByLabel("Phone number").fill(LINE_NUMBER);
    await sheet.getByLabel("New line source", { exact: true }).selectOption({ label: "Other" });
    await sheet.getByLabel("New line source detail").fill("Autumn eye camp");
    await sheet.getByRole("button", { name: "Add line" }).click();
    await expect(sheet.getByText("Line added.")).toBeVisible();
    await expect(sheet.getByTestId(/^line-row-/).filter({ hasText: `Camp line ${RUN}` })).toBeVisible();

    await sheet.getByLabel("CCS agent name").fill(`Agent ${RUN}`);
    await sheet.getByLabel("Team member", { exact: true }).selectOption({ index: 1 });
    await sheet.getByRole("button", { name: "Map agent" }).click();
    await expect(sheet.getByText("Agent mapped.")).toBeVisible();
    await page.screenshot({ path: `test-results/ccs-lines-and-team.png` });

    // --- Deliver a call exactly as CCS would (server-to-server, with a saved key)
    const connectorId = await page.evaluate(async (api) => {
      const r = await fetch(`${api}/integrations/hub/ccs_ivr`, { credentials: "include" });
      return (await r.json()).connectorId as string;
    }, API);
    const callId = `e2e-${RUN}`;
    const res = await request.post(`${API}/webhooks/ccs/${connectorId}`, {
      headers: { "x-api-key": API_KEY },
      data: { call_id: callId, caller_number: CALLER, called_number: LINE_NUMBER, agent_name: `Agent ${RUN}`, status: "Answered", duration: "86", start_time: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 19).replace("T", " "), circle: "Karnataka" },
    });
    expect(res.status()).toBe(200);
    // A missed one on the same line, and a replay of the first: the replay must not add a row.
    const missed = await request.post(`${API}/webhooks/ccs/${connectorId}`, { headers: { "x-api-key": API_KEY }, data: { call_id: `${callId}-m`, caller_number: `98${String(Math.floor(10000000 + Math.random() * 89999999))}`, called_number: LINE_NUTRIM(LINE_NUMBER), status: "No Answer", duration: "0" } });
    expect(missed.status()).toBe(200);
    expect((await request.post(`${API}/webhooks/ccs/${connectorId}`, { headers: { "x-api-key": API_KEY }, data: { call_id: callId, caller_number: CALLER, called_number: LINE_NUMBER, status: "Answered" } })).status()).toBe(200);

    // --- Recent calls
    await page.goto("/integrations?open=ccs_ivr");
    await sheet.getByTestId("detail-tab-sync").click();
    const list = sheet.getByTestId("recent-telephony-calls");
    await expect(list).toBeVisible();
    const row = list.getByRole("button").filter({ hasText: CALLER });
    await expect(row).toHaveCount(1); // one logical call, however many deliveries
    await expect(row).toContainText("Answered");
    await expect(row).toContainText("1m 26s");
    await expect(row).toContainText("Other");
    const missedRow = list.getByRole("button").filter({ hasText: "Missed" }).first();
    await expect(missedRow).toContainText("Callback due");
    await page.screenshot({ path: `test-results/ccs-recent-calls.png` });

    // --- One call opened
    await row.click();
    const detail = sheet.getByTestId("call-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(`Camp line ${RUN}`);
    await expect(detail).toContainText("Autumn eye camp");
    await expect(detail).toContainText("Karnataka");
    await expect(detail).toContainText("Not the patient's location");
    await expect(detail).toContainText(callId);
    await expect(detail.getByRole("link", { name: "Open journey" })).toHaveAttribute("href", /\/journeys\/.+/);
    await page.screenshot({ path: `test-results/ccs-call-detail.png` });
    await sheet.getByRole("button", { name: "All calls" }).click();
    await expect(list).toBeVisible();
  });
});

// The same line, written the way people write it (spaces): matching must not depend on formatting.
function LINE_NUTRIM(n: string) {
  return `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}`;
}

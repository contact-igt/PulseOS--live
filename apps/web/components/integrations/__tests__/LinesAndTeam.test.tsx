import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CommunicationEndpointVm, ConnectorAgentMappingVm } from "@pulseos/types";
import { LinesAndTeam } from "../LinesAndTeam";

// Super Admin: tell PulseOS what each IVR line is (a campaign, a health camp, the main reception) and who each CCS agent is.
// Offline sources are first-class: whatever sources the hospital defined are offered, none is assumed to be digital.

const line: CommunicationEndpointVm = {
  id: "e1", connectorId: "k1", connectorProvider: "ccs_ivr", branchId: null, branchName: null, type: "PHONE", provider: "ccs_ivr", publicNumber: "079 4000 1234", providerRef: "ivr-camp",
  displayLabel: "Health camp line", isActive: true, leadSourceId: "s-camp", leadSourceLabel: "Free Health Camp", sourceDetail: "Dhanbad camp, Oct", departmentId: null, departmentName: null,
};
const SOURCES = [{ id: "s-google", key: "google", label: "Google", bucket: "google", archived: false, sortOrder: 0 }, { id: "s-camp", key: "custom_free_health_camp", label: "Free Health Camp", bucket: "other", archived: false, sortOrder: 1 }, { id: "s-news", key: "custom_newspaper", label: "Newspaper", bucket: "other", archived: false, sortOrder: 2 }];
const USERS = [{ id: "u1", name: "Shivani", role: "FRONT_DESK" }, { id: "u2", name: "Ravi", role: "PATIENT_COORDINATOR" }];

function setup(opts: { lines?: CommunicationEndpointVm[]; mappings?: ConnectorAgentMappingVm[] } = {}) {
  const sent: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    if (method !== "GET") sent.push({ method, url, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.endsWith("/connectors/k1/endpoints") && method === "GET") return json(opts.lines ?? [line]);
    if (url.endsWith("/connectors/k1/endpoints") && method === "POST") return json({ ...line, id: "e2" }, 201);
    if (/\/endpoints\/e1$/.test(url) && method === "PATCH") return json(line);
    if (url.includes("/lead-sources")) return json(SOURCES);
    if (url.endsWith("/departments")) return json([{ id: "d1", key: "cataract", displayName: "Cataract", archived: false }]);
    if (url.endsWith("/branches")) return json([{ id: "b1", name: "Main Branch", city: "Dhanbad" }]);
    if (url.endsWith("/agent-mapping-options")) return json(USERS);
    if (url.endsWith("/agent-mappings") && method === "GET") return json(opts.mappings ?? []);
    if (url.endsWith("/agent-mappings") && method === "PUT") return json({ id: "m1", connectorId: "k1", externalAgent: String(body?.externalAgent), userId: String(body?.userId), userName: "Shivani" });
    if (/agent-mappings\/m1$/.test(url) && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><LinesAndTeam connectorId="k1" /></QueryClientProvider>);
  return { sent };
}
afterEach(() => vi.unstubAllGlobals());

describe("Lines and team", () => {
  it("lists each line with the source it is attributed to, and offers every source the hospital defined, offline ones included", async () => {
    setup();
    const row = await screen.findByTestId("line-row-e1");
    expect(row.textContent).toMatch(/Health camp line/);
    expect((within(row).getByLabelText("Source") as HTMLSelectElement).value).toBe("s-camp");
    const options = Array.from(within(row).getByLabelText("Source").querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["Phone (default)", "Google", "Free Health Camp", "Newspaper"]));
  });

  it("saving a line sends the API's own field names", async () => {
    const { sent } = setup();
    const row = await screen.findByTestId("line-row-e1");
    fireEvent.change(within(row).getByLabelText("Source"), { target: { value: "s-news" } });
    fireEvent.change(within(row).getByLabelText("Source detail"), { target: { value: "Dainik, Sunday" } });
    fireEvent.click(within(row).getByRole("button", { name: /save line/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PATCH", url: expect.stringContaining("/connectors/k1/endpoints/e1"), body: { leadSourceId: "s-news", sourceDetail: "Dainik, Sunday", departmentId: null, branchId: null } });
  });

  it("choosing 'Phone (default)' clears the attribution (null), it never sends an empty string id", async () => {
    const { sent } = setup();
    const row = await screen.findByTestId("line-row-e1");
    fireEvent.change(within(row).getByLabelText("Source"), { target: { value: "" } });
    fireEvent.click(within(row).getByRole("button", { name: /save line/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body!.leadSourceId).toBeNull();
  });

  it("adds a line: label, number and the attribution, with the provider reference derived from the number", async () => {
    const { sent } = setup({ lines: [] });
    expect(await screen.findByText(/no lines yet/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Line name"), { target: { value: "Newspaper ad" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "080 4000 5678" } });
    fireEvent.change(screen.getByLabelText("New line source"), { target: { value: "s-news" } });
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "POST", body: { type: "PHONE", displayLabel: "Newspaper ad", publicNumber: "080 4000 5678", leadSourceId: "s-news", providerRef: "line-08040005678" } });
  });

  it("will not add a line without a name and a number", async () => {
    const { sent } = setup({ lines: [] });
    await screen.findByText(/no lines yet/i);
    fireEvent.click(screen.getByRole("button", { name: /add line/i }));
    expect(sent).toHaveLength(0);
    expect(screen.getByText(/enter a name and a phone number/i)).toBeTruthy();
  });

  it("maps a CCS agent to a team member, and says this only records who handled the call", async () => {
    const { sent } = setup();
    await screen.findByTestId("line-row-e1");
    expect(screen.getByText(/does not change who owns a journey/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CCS agent name"), { target: { value: "Shivi" } });
    fireEvent.change(screen.getByLabelText("Team member"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: /map agent/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "PUT", body: { externalAgent: "Shivi", userId: "u1" } });
  });

  it("shows existing agent mappings and removes one", async () => {
    const { sent } = setup({ mappings: [{ id: "m1", connectorId: "k1", externalAgent: "Shivi", userId: "u1", userName: "Shivani" }] });
    const row = await screen.findByTestId("agent-row-m1");
    expect(row.textContent).toMatch(/Shivi/);
    expect(row.textContent).toMatch(/Shivani/);
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: "DELETE", url: expect.stringContaining("/agent-mappings/m1") });
  });
});

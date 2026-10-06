import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrationDetail } from "@pulseos/types";
import { ConfigurationForm } from "../IntegrationDetailSheet";

// CCS IVR > Credentials. Synthetic values only. The form must send exactly the field names the API accepts, never
// resubmit a saved secret it cannot see, keep what the user typed when a save fails, and say something useful instead of
// "Could not save: internal_error".

function detail(over: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    key: "ccs_ivr", category: "CALLING", name: "CCS IVR (Express IVR)", provider: "CCS IVRSMS", purpose: "p", capability: "CCS_IVR",
    enabled: true, configuration: "CONFIGURED", health: "HEALTHY", mode: "LIVE_CONFIGURED", blockedReason: null,
    lastSyncAt: null, lastEventAt: null, lastError: null, canConfigure: true, canManageSecrets: true, phoneNumbers: [], isConnected: false,
    configurationFields: [{ key: "accountEmail", label: "Account Email" }],
    configurationValues: { accountEmail: "" },
    secretFields: [
      { key: "apiKey", label: "API Key", hasSecret: false },
      { key: "secretKey", label: "Secret Key", hasSecret: false },
      { key: "integrationKey", label: "Integration Key", hasSecret: false },
    ],
    mappingNotes: null, webhookUrl: null, connectorMode: "LIVE",
    ...over,
  } as IntegrationDetail;
}
function setup(d: IntegrationDetail, put: () => Response | Promise<Response> = () => new Response(JSON.stringify(d), { status: 200 })) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") bodies.push(JSON.parse(init.body as string));
    return put();
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><ConfigurationForm d={d} secrets /></QueryClientProvider>);
  return { bodies, invalidate };
}
const type = (k: string, v: string) => fireEvent.change(screen.getByTestId(`secret-${k}`), { target: { value: v } });
const save = () => fireEvent.click(screen.getByTestId("save-credentials"));
afterEach(() => vi.unstubAllGlobals());

describe("CCS IVR credentials form", () => {
  it("sends the API's own field names (apiKey, secretKey, integrationKey) and nothing else", async () => {
    const { bodies, invalidate } = setup(detail());
    type("apiKey", "synthetic-api"); type("secretKey", "synthetic-secret"); type("integrationKey", "synthetic-integration");
    save();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ secrets: { apiKey: "synthetic-api", secretKey: "synthetic-secret", integrationKey: "synthetic-integration" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["integration-hub"] });
  });

  it("shows saved secrets as set without any value, and does not resubmit them when left blank", async () => {
    const { bodies } = setup(detail({ secretFields: [
      { key: "apiKey", label: "API Key", hasSecret: true },
      { key: "secretKey", label: "Secret Key", hasSecret: true },
      { key: "integrationKey", label: "Integration Key", hasSecret: false },
    ] }));
    expect(screen.getAllByText("Secret saved")).toHaveLength(2);
    expect((screen.getByTestId("secret-apiKey") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("secret-apiKey").getAttribute("placeholder")).toMatch(/leave blank/i);
    type("integrationKey", "synthetic-integration"); // update only one
    save();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.secrets).toEqual({ integrationKey: "synthetic-integration" });
    expect(JSON.stringify(bodies[0])).not.toMatch(/•/);
  });

  it("a stored-but-unreadable secret is not shown as 'Not set' and the form explains how to fix it", () => {
    setup(detail({ secretsUnreadable: true, secretFields: [
      { key: "apiKey", label: "API Key", hasSecret: false },
      { key: "secretKey", label: "Secret Key", hasSecret: false },
      { key: "integrationKey", label: "Integration Key", hasSecret: false },
    ] }));
    expect(screen.queryByText("Not set")).toBeNull();
    expect(screen.getAllByText(/saved · unreadable/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toMatch(/re-enter/i);
  });

  it("keeps what was typed and shows a safe, useful message when the server cannot store secrets", async () => {
    setup(detail(), () => new Response(JSON.stringify({ error: "encryption_not_configured" }), { status: 503 }));
    type("apiKey", "synthetic-api");
    save();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/secure credential storage isn.t set up/i));
    expect(screen.getByRole("status").textContent).not.toMatch(/internal_error|encryption_not_configured/);
    expect((screen.getByTestId("secret-apiKey") as HTMLInputElement).value).toBe("synthetic-api");
  });

  it("never shows the raw 'internal_error' code", async () => {
    setup(detail(), () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }));
    type("apiKey", "synthetic-api");
    save();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/credentials could not be saved/i));
    expect(screen.getByRole("status").textContent).not.toMatch(/internal_error/);
  });
});

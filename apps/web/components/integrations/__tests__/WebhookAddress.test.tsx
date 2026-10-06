import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WebhookAddress } from "../WebhookAddress";

// CCS's Webhook Configuration takes only a URL (no header), so the one secret that survives is a token PulseOS generates and puts in
// the URL path. It is shown ONCE, here, and never again. Synthetic values only.

const URL_ONCE = "https://api.example.test/webhooks/ccs/11111111-2222-4333-8444-555555555555/synthetic-token-abcdefghijklmnopqrstuvwx";

function setup(opts: { tokenSet: boolean; canManage?: boolean; respond?: () => Response }) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url });
    return opts.respond ? opts.respond() : new Response(JSON.stringify({ webhookUrl: URL_ONCE }), { status: 200 });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><WebhookAddress integrationKey="ccs_ivr" tokenSet={opts.tokenSet} canManage={opts.canManage ?? true} /></QueryClientProvider>);
  return { calls, view };
}
afterEach(() => vi.unstubAllGlobals());

describe("Secure webhook address", () => {
  it("before one exists it says so and offers to create it", () => {
    setup({ tokenSet: false });
    expect(screen.getByText(/no secure webhook address yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create secure webhook address/i })).toBeTruthy();
    expect(screen.queryByTestId("webhook-address-once")).toBeNull();
  });

  it("creating it shows the complete address once, with the reason and a warning that it will not be shown again", async () => {
    const { calls } = setup({ tokenSet: false });
    fireEvent.click(screen.getByRole("button", { name: /create secure webhook address/i }));
    const box = await screen.findByTestId("webhook-address-once");
    expect(box.textContent).toBe(URL_ONCE);
    expect(calls).toEqual([{ method: "POST", url: expect.stringContaining("/integrations/hub/ccs_ivr/webhook-token") }]);
    expect(screen.getByText(/shown only once/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy address/i })).toBeTruthy();
  });

  it("when one already exists it never shows it, and replacing needs a deliberate second step that warns the old address stops working", async () => {
    const { calls } = setup({ tokenSet: true });
    expect(screen.getByText(/a secure webhook address exists/i)).toBeTruthy();
    expect(screen.queryByTestId("webhook-address-once")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /replace address/i }));
    expect(calls).toHaveLength(0); // nothing happens on the first click
    expect(screen.getByText(/old address stops working/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /yes, replace it/i }));
    expect((await screen.findByTestId("webhook-address-once")).textContent).toBe(URL_ONCE);
    expect(calls).toHaveLength(1);
  });

  it("a failure says what to do and shows no address", async () => {
    setup({ tokenSet: false, respond: () => new Response(JSON.stringify({ error: "encryption_not_configured" }), { status: 503 }) });
    fireEvent.click(screen.getByRole("button", { name: /create secure webhook address/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/secure credential storage isn.t set up/i));
    expect(screen.queryByTestId("webhook-address-once")).toBeNull();
    expect(screen.getByRole("alert").textContent).not.toMatch(/encryption_not_configured|internal_error/);
  });

  it("without permission it explains who can, and offers no button", () => {
    setup({ tokenSet: true, canManage: false });
    expect(screen.getByText(/only a super admin/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /replace address|create secure/i })).toBeNull();
  });
});

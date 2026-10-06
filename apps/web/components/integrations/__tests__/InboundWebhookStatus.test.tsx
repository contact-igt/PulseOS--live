import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { IntegrationInboundState } from "@pulseos/types";
import { InboundWebhookStatus } from "../IntegrationDetailSheet";

// CCS receives calls by webhook; there is no outbound call PulseOS could use to "test the connection". So the screen
// states four separate facts and never a claimed connection.

const base: IntegrationInboundState = { webhook: "READY", credentials: "SAVED", lastValidEventAt: null, note: "Each call report must carry a saved key." };

describe("Inbound webhook status", () => {
  it("ready: webhook Ready, credentials Saved, and 'No call report yet' rather than an invented time", () => {
    render(<InboundWebhookStatus inbound={base} />);
    expect(screen.getByTestId("inbound-webhook").textContent).toBe("Ready");
    expect(screen.getByTestId("inbound-credentials").textContent).toBe("Saved");
    expect(screen.getByTestId("inbound-last-event").textContent).toMatch(/no call report yet/i);
    expect(screen.getByText(/must carry a saved key/i)).toBeTruthy();
  });

  it("no key saved: Not ready / Not configured, with the reason shown", () => {
    render(<InboundWebhookStatus inbound={{ ...base, webhook: "NOT_READY", credentials: "NOT_CONFIGURED", note: "Call reports are refused until at least one key is saved." }} />);
    expect(screen.getByTestId("inbound-webhook").textContent).toBe("Not ready");
    expect(screen.getByTestId("inbound-credentials").textContent).toBe("Not configured");
    expect(screen.getByText(/refused until at least one key is saved/i)).toBeTruthy();
  });

  it("unreadable credentials are called unreadable, never Saved or Not configured", () => {
    render(<InboundWebhookStatus inbound={{ ...base, webhook: "NOT_READY", credentials: "UNREADABLE", note: "Saved credentials cannot be read by this server." }} />);
    expect(screen.getByTestId("inbound-credentials").textContent).toBe("Unreadable");
    expect(screen.getByTestId("inbound-webhook").textContent).toBe("Not ready");
  });

  it("shows when the last valid call report arrived", () => {
    render(<InboundWebhookStatus inbound={{ ...base, lastValidEventAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }} />);
    expect(screen.getByTestId("inbound-last-event").textContent).toMatch(/2h ago|2 hours ago/i);
  });
});

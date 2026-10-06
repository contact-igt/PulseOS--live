import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TelephonyCallDetail, TelephonyCallRecord } from "@pulseos/types";
import { CallDetailPanel, RecentCalls } from "../TelephonyCalls";

// Recent calls: who called, how it went, who handled it, where it came from, what is next. One call opens as a detail.
// Synthetic data only.

const base: TelephonyCallRecord = {
  id: "c1", phone: "+919810157258", direction: "inbound", status: "completed", durationSeconds: 86, startedAt: new Date().toISOString(), hasRecording: true,
  journeyId: "j1", patientId: "p1", patientName: null, agentName: "Shivi", handledByName: "Shivani", lineLabel: "Health camp line", sourceLabel: "Free Health Camp", nextAction: null, isTest: false,
};
const missed: TelephonyCallRecord = { ...base, id: "c2", status: "missed", durationSeconds: 0, hasRecording: false, handledByName: null, agentName: null, patientName: "Asha Rao", nextAction: { taskId: "t1", type: "CALLBACK", dueAt: new Date(Date.now() + 3_600_000).toISOString() } };

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
afterEach(() => vi.unstubAllGlobals());

describe("Recent calls", () => {
  it("an answered call shows the caller's number (no invented name), status, duration, who handled it and the source", () => {
    wrap(<RecentCalls calls={[base]} onOpen={() => {}} />);
    const row = screen.getByTestId("call-row-c1");
    expect(within(row).getByText("+919810157258")).toBeTruthy();
    expect(row.textContent).toMatch(/Answered/);
    expect(row.textContent).toMatch(/Incoming/);
    expect(row.textContent).toMatch(/1m 26s/);
    expect(row.textContent).toMatch(/Shivani/);
    expect(row.textContent).toMatch(/Free Health Camp/);
    expect(row.textContent).toMatch(/Recording/);
    expect(row.textContent).not.toMatch(/Unknown|John|undefined/);
  });

  it("a missed call says Missed in words, names the patient when known, and shows the callback that is due", () => {
    wrap(<RecentCalls calls={[missed]} onOpen={() => {}} />);
    const row = screen.getByTestId("call-row-c2");
    expect(row.textContent).toMatch(/Missed/);
    expect(row.textContent).toMatch(/Asha Rao/);
    expect(row.textContent).toMatch(/Callback due/);
    expect(row.textContent).not.toMatch(/Recording/);
  });

  it("an unmapped provider agent is shown by the provider's name and flagged as not mapped", () => {
    wrap(<RecentCalls calls={[{ ...base, handledByName: null, agentName: "Poonam Jain" }]} onOpen={() => {}} />);
    expect(screen.getByTestId("call-row-c1").textContent).toMatch(/Poonam Jain/);
    expect(screen.getByTestId("call-row-c1").textContent).toMatch(/not mapped/i);
  });

  it("a simulated test call says Test in words, so it is never mistaken for a real call", () => {
    wrap(<RecentCalls calls={[{ ...base, id: "t1", isTest: true }]} onOpen={() => {}} />);
    expect(within(screen.getByTestId("call-row-t1")).getByText("Test")).toBeTruthy();
    wrap(<RecentCalls calls={[base]} onOpen={() => {}} />);
    expect(within(screen.getAllByTestId("call-row-c1")[0]!).queryByText("Test")).toBeNull();
  });

  it("clicking a call opens it", () => {
    const onOpen = vi.fn();
    wrap(<RecentCalls calls={[base, missed]} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId("call-row-c2"));
    expect(onOpen).toHaveBeenCalledWith("c2");
  });

  it("with no calls it tells the person what to do, and says a test call is simulated", () => {
    wrap(<RecentCalls calls={[]} onOpen={() => {}} />);
    expect(screen.getByText(/no calls received yet/i)).toBeTruthy();
    expect(screen.getByTestId("recent-calls-empty").textContent).toMatch(/simulated/i);
    expect(screen.getByTestId("recent-calls-empty").textContent).not.toMatch(/⚡/);
  });
});

describe("Call detail", () => {
  const detail: TelephonyCallDetail = {
    ...base, providerCallId: "ccs-1001", providerLabel: "CCS Express IVR", calledLine: "07940001234", callGroup: "Camp desk", circle: "Karnataka", ivrSelection: "2",
    providerStatus: "Answered", answeredAt: null, endedAt: null, sourceDetail: "Dhanbad camp, Oct",
  };
  function stub(d: TelephonyCallDetail | number) {
    vi.stubGlobal("fetch", vi.fn(async () => (typeof d === "number" ? new Response(JSON.stringify({ error: "call_not_found" }), { status: d }) : new Response(JSON.stringify(d), { status: 200 }))));
  }

  it("shows the caller, line, status, duration, handler, group, source attribution, provider ids and the journey link", async () => {
    stub(detail);
    wrap(<CallDetailPanel integrationKey="ccs_ivr" callId="c1" onBack={() => {}} canPlay canDownload={false} />);
    const panel = await screen.findByTestId("call-detail");
    const t = panel.textContent ?? "";
    for (const expected of ["+919810157258", "Incoming", "Answered", "1m 26s", "Shivani", "Camp desk", "07940001234", "Health camp line", "Free Health Camp", "Dhanbad camp, Oct", "CCS Express IVR", "ccs-1001"]) expect(t, expected).toContain(expected);
    expect(within(panel).getByRole("link", { name: /open journey/i }).getAttribute("href")).toBe("/journeys/j1");
  });

  it("labels the telecom circle as approximate and never calls it a location", async () => {
    stub(detail);
    wrap(<CallDetailPanel integrationKey="ccs_ivr" callId="c1" onBack={() => {}} canPlay canDownload={false} />);
    const panel = await screen.findByTestId("call-detail");
    expect(panel.textContent).toMatch(/Telecom circle/);
    expect(panel.textContent).toMatch(/approximate/i);
    expect(panel.textContent).not.toMatch(/\bLocation\b|\bCity\b/);
  });

  it("recording: a role that may play it gets a player that asks PulseOS (never a provider URL); others see only that one exists", async () => {
    stub(detail);
    const { unmount } = wrap(<CallDetailPanel integrationKey="ccs_ivr" callId="c1" onBack={() => {}} canPlay canDownload={false} />);
    fireEvent.click(await screen.findByRole("button", { name: /play recording/i }));
    const audio = document.querySelector("audio")!;
    expect(audio.getAttribute("src")).toMatch(/\/calls\/c1\/recording$/);
    unmount();
    wrap(<CallDetailPanel integrationKey="ccs_ivr" callId="c1" onBack={() => {}} canPlay={false} canDownload={false} />);
    await screen.findByTestId("call-detail");
    expect(screen.queryByRole("button", { name: /play recording/i })).toBeNull();
    expect(screen.getByText(/recording on file/i)).toBeTruthy();
  });

  it("an unavailable call says so, and Back returns to the list", async () => {
    stub(404);
    const onBack = vi.fn();
    wrap(<CallDetailPanel integrationKey="ccs_ivr" callId="nope" onBack={onBack} canPlay canDownload={false} />);
    await waitFor(() => expect(screen.getByText(/could not load this call/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /all calls/i }));
    expect(onBack).toHaveBeenCalled();
  });
});

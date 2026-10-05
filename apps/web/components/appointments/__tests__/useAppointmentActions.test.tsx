import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/appointments", useSearchParams: () => new URLSearchParams("") }));

import type { AppointmentRow } from "@pulseos/types";
import { useAppointmentActions } from "../hooks";

const row = { id: "a1" } as AppointmentRow;

async function reschedule(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const onDone = vi.fn();
  // The hospital's clock comes from the session; seed it so the stubbed fetch only sees the reschedule call.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["session"], { user: { timezone: "Asia/Kolkata" } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useAppointmentActions({ refresh: vi.fn(), onDone }), { wrapper });
  await act(() => result.current.handleReschedule(row, { date: "2026-10-02", time: "10:00", reasonCode: "patient_requested" }));
  return { onDone, error: result.current.error, drawerError: result.current.drawerErrorFor(row.id), drawerErrorElsewhere: result.current.drawerErrorFor("another-appointment") };
}

describe("useAppointmentActions (the drawer keeps what the user typed on a recoverable failure)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a network failure keeps the drawer open and reports the error", async () => {
    const { onDone, error, drawerError, drawerErrorElsewhere } = await reschedule(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(onDone).not.toHaveBeenCalled();
    expect(drawerError).toMatch(/try again/i);
    expect(error).toBeNull(); // not a page-level notice: the drawer is still open and shows it
    expect(drawerErrorElsewhere).toBeNull(); // and it never follows the user to another appointment
  });

  it("a state change on the server (409) closes the drawer: the appointment is no longer what the user saw", async () => {
    const { onDone, error, drawerError } = await reschedule(async () => new Response(JSON.stringify({ error: "appointment_closed" }), { status: 409 }));
    expect(onDone).toHaveBeenCalled();
    expect(error).toMatch(/already closed/i); // page-level notice, visible after the drawer closed
    expect(drawerError).toBeNull();
  });

  it("success closes the drawer", async () => {
    const { onDone, error } = await reschedule(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(onDone).toHaveBeenCalled();
    expect(error).toBeNull();
  });
});

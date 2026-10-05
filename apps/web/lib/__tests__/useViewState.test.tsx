import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Reads follow the address bar; writes go through history.replaceState (replaceUrlParams).
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useViewState } from "../useViewState";
import { useUrlFilters } from "../useUrlFilters";

const opts = { views: ["list", "calendar"] as const, defaultView: "list" as const, defaultRange: "week" as const, timeZone: "Asia/Kolkata" };
const at = (search: string) => window.history.replaceState(null, "", `/my-work${search ? `?${search}` : ""}`);
const q = () => new URLSearchParams(window.location.search);

describe("useViewState calendar mode", () => {
  beforeEach(() => at(""));

  it("calendar mode follows the range until Agenda is picked", () => {
    at("view=calendar&range=month");
    expect(renderHook(() => useViewState(opts)).result.current.calendarMode).toBe("month");
  });

  it("Agenda lives in the URL (cal=agenda) and keeps the range as its span", () => {
    at("view=calendar&range=month&status=open");
    renderHook(() => useViewState(opts)).result.current.setCalendarMode("agenda");
    expect(q().get("cal")).toBe("agenda");
    expect(q().get("range")).toBe("month");
    expect(q().get("status")).toBe("open");
    const again = renderHook(() => useViewState(opts)).result.current;
    expect(again.calendarMode).toBe("agenda");
    expect(again.range).toBe("month");
  });

  it("picking a grid mode clears Agenda and drops a default range from the URL", () => {
    at("view=calendar&range=month&cal=agenda");
    renderHook(() => useViewState(opts)).result.current.setCalendarMode("week");
    expect(window.location.search).toBe("?view=calendar");
  });

  it("two updates in one handler both land (open a day from month view: date + Day mode)", () => {
    at("view=calendar&range=month&date=2026-09-01");
    const s = renderHook(() => useViewState(opts)).result.current;
    s.setDate("2026-09-29");
    s.setCalendarMode("day");
    expect(q().get("date")).toBe("2026-09-29");
    expect(q().get("range")).toBe("day");
  });

  it("a filter written by another hook between two view updates is never lost or resurrected", () => {
    at("");
    const view = renderHook(() => useViewState(opts)).result.current;
    const filters = renderHook(() => useUrlFilters()).result.current;
    filters.set({ stage: "waiting" });
    view.setView("calendar");
    filters.set({ stage: undefined, q: "asha" });
    view.setDate("2026-10-02");
    expect(window.location.search).toBe("?view=calendar&q=asha&date=2026-10-02");
  });

  it("a search that returns to an identical URL leaves no stale state behind", () => {
    at("view=calendar&date=2026-10-02");
    const filters = renderHook(() => useUrlFilters()).result.current;
    filters.set({ q: "a" });
    filters.set({ q: undefined });
    const view = renderHook(() => useViewState(opts)).result.current;
    view.setView("list");
    expect(window.location.search).toBe("?date=2026-10-02");
  });
});

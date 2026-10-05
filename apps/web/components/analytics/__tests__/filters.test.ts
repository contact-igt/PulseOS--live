import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, activeFilters, parseFilters, toApiQuery, toSearch, customRangeDefaults, earliestFrom } from "../filters";

describe("analytics filter state (URL is the single source of truth)", () => {
  it("defaults to 30 days, Overview, nothing filtered", () => {
    const f = parseFilters(new URLSearchParams(""));
    expect(f).toEqual(DEFAULT_FILTERS);
    expect(toSearch(f)).toBe("");
    expect(activeFilters(f)).toEqual([]);
  });

  it("round-trips every filter through the query string", () => {
    const qs = "tab=acquisition&range=14d&branch=b1&service=Cataract&source=meta&campaign=c1";
    const f = parseFilters(new URLSearchParams(qs));
    expect(f).toMatchObject({ tab: "acquisition", range: "14d", branchId: "b1", service: "Cataract", source: "meta", campaignId: "c1" });
    expect(new URLSearchParams(toSearch(f))).toEqual(new URLSearchParams(qs));
  });

  it("maps to the API query (branch -> branchId, campaign -> campaignId) without the tab", () => {
    const f = parseFilters(new URLSearchParams("tab=revenue&branch=b1&campaign=c1&source=google"));
    expect(toApiQuery(f)).toEqual({ range: "30d", branchId: "b1", campaignId: "c1", source: "google" });
  });

  it("keeps a custom range only when both dates are real, else falls back to 30 days", () => {
    expect(parseFilters(new URLSearchParams("range=custom&from=2026-09-01&to=2026-09-10"))).toMatchObject({ range: "custom", from: "2026-09-01", to: "2026-09-10" });
    expect(parseFilters(new URLSearchParams("range=custom&from=2026-09-01"))).toMatchObject({ range: "30d" });
    expect(parseFilters(new URLSearchParams("range=custom&from=2026-02-31&to=2026-03-02"))).toMatchObject({ range: "30d" });
    expect(parseFilters(new URLSearchParams("range=custom&from=2026-09-10&to=2026-09-01"))).toMatchObject({ range: "30d" });
  });

  it("ignores unknown tabs, ranges and sources", () => {
    const f = parseFilters(new URLSearchParams("tab=nope&range=5y&source=telepathy"));
    expect(f).toMatchObject({ tab: "overview", range: "30d", source: undefined });
  });

  it("lists active filters (the range is only 'active' when it is not the default)", () => {
    const f = parseFilters(new URLSearchParams("range=7d&source=meta&service=Squint"));
    expect(activeFilters(f).map((a) => a.key)).toEqual(["range", "service", "source"]);
    expect(activeFilters(parseFilters(new URLSearchParams("range=30d"))).length).toBe(0);
  });

  it("switching tab keeps filters; the tab itself is not a filter", () => {
    const f = parseFilters(new URLSearchParams("source=meta&tab=team"));
    expect(activeFilters(f).map((a) => a.key)).toEqual(["source"]);
  });

  it("custom range defaults to the last 30 hospital days and cannot reach back past the API's 366-day limit", () => {
    expect(customRangeDefaults("2026-10-01")).toEqual({ from: "2026-09-02", to: "2026-10-01" });
    expect(customRangeDefaults("2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
    expect(earliestFrom("2026-10-01")).toBe("2025-10-01"); // 366 days inclusive
    expect(earliestFrom("2024-03-01")).toBe("2023-03-02"); // a leap day sits inside the window
  });
});

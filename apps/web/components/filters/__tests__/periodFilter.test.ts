import { describe, expect, it } from "vitest";
import { DATE_PRESETS } from "@pulseos/types";
import { periodPatch, readPeriod, readPeriodChoice } from "../periodFilter";

const opts = { prefix: "p", defaultRange: "30d", presets: DATE_PRESETS.filter((p) => p.key !== "90d"), today: "2026-10-03" } as const;
const read = (qs: string) => readPeriod(new URLSearchParams(qs), opts);

describe("readPeriod", () => {
  it("falls back to the default preset when the URL has none", () => {
    expect(read("")).toMatchObject({ range: "30d", from: "2026-09-04", to: "2026-10-03" });
  });

  it("resolves a preset in the hospital's calendar (today is passed in, never the browser clock)", () => {
    expect(read("prange=yesterday")).toMatchObject({ range: "yesterday", from: "2026-10-02", to: "2026-10-02" });
    expect(read("prange=this_month")).toMatchObject({ from: "2026-10-01", to: "2026-10-03" });
    expect(read("prange=prev_month")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("reads a custom range only when both ends are real days in order", () => {
    expect(read("prange=custom&pfrom=2026-09-10&pto=2026-09-12")).toMatchObject({ range: "custom", from: "2026-09-10", to: "2026-09-12" });
    expect(read("prange=custom&pfrom=2026-09-12&pto=2026-09-10").range).toBe("30d");
    expect(read("prange=custom&pfrom=2026-02-31&pto=2026-03-01").range).toBe("30d");
    expect(read("prange=custom").range).toBe("30d");
  });

  it("ignores a preset this list does not offer (an old shared link) and unknown values", () => {
    expect(read("prange=90d").range).toBe("30d");
    expect(read("prange=forever").range).toBe("30d");
  });

  it("keeps other lists' keys apart via the prefix", () => {
    expect(readPeriod(new URLSearchParams("range=7d&prange=9d"), opts).range).toBe("9d");
  });
});

describe("periodPatch", () => {
  it("omits the default so a shared link stays short", () => {
    expect(periodPatch({ range: "30d", from: undefined, to: undefined }, opts)).toEqual({ prange: undefined, pfrom: undefined, pto: undefined });
  });

  it("writes a preset, and from/to only for custom", () => {
    expect(periodPatch({ range: "7d", from: "x", to: "y" }, opts)).toEqual({ prange: "7d", pfrom: undefined, pto: undefined });
    expect(periodPatch({ range: "custom", from: "2026-09-10", to: "2026-09-12" }, opts)).toEqual({ prange: "custom", pfrom: "2026-09-10", pto: "2026-09-12" });
  });
});

describe("readPeriodChoice (lists whose default is 'Any date')", () => {
  const o = { prefix: "lg", presets: DATE_PRESETS } as const;
  const choice = (qs: string) => readPeriodChoice(new URLSearchParams(qs), o);

  it("is empty when the URL has no period", () => {
    expect(choice("")).toEqual({ range: undefined, from: undefined, to: undefined });
  });

  it("returns an offered preset unresolved (the panel resolves it in the hospital's calendar)", () => {
    expect(choice("lgrange=7d")).toEqual({ range: "7d", from: undefined, to: undefined });
  });

  it("returns a custom range only when both ends are real days in order", () => {
    expect(choice("lgrange=custom&lgfrom=2026-09-10&lgto=2026-09-12")).toEqual({ range: "custom", from: "2026-09-10", to: "2026-09-12" });
    expect(choice("lgrange=custom&lgfrom=2026-09-12&lgto=2026-09-10").range).toBeUndefined();
    expect(choice("lgrange=custom").range).toBeUndefined();
  });

  it("ignores values it does not offer", () => {
    expect(choice("lgrange=forever").range).toBeUndefined();
  });

  it("round-trips through periodPatch with an empty default", () => {
    expect(periodPatch({ range: undefined, from: undefined, to: undefined }, { prefix: "lg", defaultRange: "" })).toEqual({ lgrange: undefined, lgfrom: undefined, lgto: undefined });
    expect(periodPatch({ range: "9d", from: undefined, to: undefined }, { prefix: "lg", defaultRange: "" })).toEqual({ lgrange: "9d", lgfrom: undefined, lgto: undefined });
  });
});

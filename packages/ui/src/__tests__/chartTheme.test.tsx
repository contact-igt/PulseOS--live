import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChartEmptyState, ChartLegend, ChartTooltipCard, TrendIndicator } from "../AnalyticsPanel";
import { DailySourceChart } from "../DailySourceChart";
import {
  SERIES_PALETTE,
  chartSourceKey,
  fmtBucketLabel,
  fmtCountNum,
  fmtDayShort,
  fmtPct,
  fmtRoasX,
  fmtInrAxis,
  niceCountAxis,
  niceMoneyAxis,
  pctChange,
  sourceColor,
} from "../chartTheme";

describe("chart theme", () => {
  it("gives every source a stable colour from the validated palette; organic folds into Other", () => {
    expect(SERIES_PALETTE).toHaveLength(8);
    expect(new Set(SERIES_PALETTE).size).toBe(8);
    expect(sourceColor("meta")).toBe(SERIES_PALETTE[0]);
    expect(sourceColor("google")).toBe(SERIES_PALETTE[1]);
    expect(sourceColor("organic")).toBe(sourceColor("other"));
    expect(chartSourceKey("organic")).toBe("other");
  });

  it("formats numbers for dense analytics", () => {
    expect(fmtRoasX(2.06)).toBe("2.1×");
    expect(fmtRoasX(null)).toBe("—");
    expect(fmtPct(0.7714)).toBe("77%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtCountNum(1284)).toBe("1,284");
    expect(fmtDayShort("2026-09-07")).toBe("7 Sep");
  });

  it("labels a multi-day bucket by its span and flags a partial one", () => {
    expect(fmtBucketLabel({ key: "2026-09-07", to: "2026-09-13", days: 7, partial: false })).toBe("7–13 Sep");
    expect(fmtBucketLabel({ key: "2026-09-28", to: "2026-09-29", days: 2, partial: true })).toBe("28–29 Sep (2 days)");
    expect(fmtBucketLabel({ key: "2026-09-28", to: "2026-09-28", days: 1, partial: false })).toBe("28 Sep");
    expect(fmtBucketLabel({ key: "2026-08-28", to: "2026-09-03", days: 7, partial: false })).toBe("28 Aug – 3 Sep");
  });

  it("computes a percentage change and refuses to invent one without a baseline", () => {
    expect(pctChange(12, 10)).toBeCloseTo(0.2);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
  });
});

describe("axes", () => {
  it("keeps count gridlines on whole numbers with the smallest tidy step", () => {
    expect(niceCountAxis(0)).toEqual({ max: 3, ticks: [0, 1, 2, 3] });
    expect(niceCountAxis(5)).toEqual({ max: 6, ticks: [0, 2, 4, 6] });
    expect(niceCountAxis(13)).toEqual({ max: 15, ticks: [0, 5, 10, 15] });
    expect(niceCountAxis(42).ticks).toEqual([0, 20, 40, 60]);
  });

  it("puts money gridlines on tidy rupee values", () => {
    expect(niceMoneyAxis(219000)).toEqual({ max: 250000, ticks: [0, 50000, 100000, 150000, 200000, 250000] });
    expect(niceMoneyAxis(42000).ticks).toEqual([0, 10000, 20000, 30000, 40000, 50000]);
    expect(niceMoneyAxis(0).max).toBeGreaterThan(0);
  });

  it("writes axis money in lakh / thousand without trailing zeros", () => {
    expect(fmtInrAxis(0)).toBe("₹0");
    expect(fmtInrAxis(50000)).toBe("₹50K");
    expect(fmtInrAxis(100000)).toBe("₹1L");
    expect(fmtInrAxis(150000)).toBe("₹1.5L");
    expect(fmtInrAxis(250000)).toBe("₹2.5L");
  });
});

describe("chart primitives", () => {
  it("TrendIndicator states direction in words, not colour alone, and shows no delta without a baseline", () => {
    const { rerender } = render(<TrendIndicator current={12} previous={10} label="prev 30D" />);
    expect(screen.getByText(/\+20%/)).toBeTruthy();
    expect(screen.getByText(/up/i)).toBeTruthy();
    rerender(<TrendIndicator current={5} previous={0} label="prev 30D" />);
    expect(screen.getByText(/no prior/i)).toBeTruthy();
  });

  it("ChartLegend renders buttons only when items are actionable", () => {
    render(<ChartLegend items={[{ key: "meta", label: "Meta", color: "#2584b2", value: 12 }]} onItemClick={() => {}} />);
    expect(screen.getByRole("button", { name: /Meta/ })).toBeTruthy();
  });

  it("ChartEmptyState explains an empty period", () => {
    render(<ChartEmptyState message="No enquiries in this period" hint="Try a wider range." />);
    expect(screen.getByText("No enquiries in this period")).toBeTruthy();
  });

  it("ChartTooltipCard lists rows with value first and a total footer", () => {
    render(<ChartTooltipCard title="7 Sep" rows={[{ key: "meta", label: "Meta", color: "#2584b2", value: "3", share: "60%" }]} footer={{ label: "Total", value: "5" }} />);
    expect(screen.getByText("7 Sep")).toBeTruthy();
    expect(screen.getByText("60%")).toBeTruthy();
    expect(screen.getByText("Total")).toBeTruthy();
  });
});

describe("DailySourceChart", () => {
  const day = (key: string, meta: number) => ({ key, to: key, days: 1, partial: false, total: meta, bySource: { meta }, previousTotal: null });
  it("labels the still-running day 'Today' instead of presenting it as a finished short day", () => {
    render(
      <DailySourceChart
        data={{ buckets: [day("2026-09-29", 4), day("2026-09-30", 1)], sources: ["meta"], granularity: "day", total: 5, period: { today: "2026-09-30" } }}
      />,
    );
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/today is still in progress/i);
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { KpiStripSection } from "../KpiStrip";

const DATA = {
  newEnquiries: 2,
  appointmentsToday: 16,
  waitingNow: 3,
  consultationsCompleted: 4,
  treatmentDecisionsPending: 2,
  attributedRevenue: 138000,
};

describe("KpiStripSection", () => {
  it("formats revenue in lakhs above one lakh", () => {
    render(<KpiStripSection data={DATA} />);
    expect(screen.getByText("₹1.4L")).toBeTruthy();
  });

  it("formats revenue in compact thousands between 1,000 and one lakh", () => {
    render(<KpiStripSection data={{ ...DATA, attributedRevenue: 38000 }} />);
    expect(screen.getByText("₹38.0K")).toBeTruthy();
  });

  it("formats revenue as plain whole rupees below 1,000 — never a 3-decimal value", () => {
    render(<KpiStripSection data={{ ...DATA, attributedRevenue: 466.667 }} />);
    expect(screen.getByText("₹467")).toBeTruthy();
  });

  it("calls onSegmentClick with the KPI key", () => {
    const onSegmentClick = vi.fn();
    render(<KpiStripSection data={DATA} onSegmentClick={onSegmentClick} />);
    const card = screen.getByTestId("kpi-waitingNow");
    fireEvent.click(card);
    expect(onSegmentClick).toHaveBeenCalledWith("waitingNow");
  });
});

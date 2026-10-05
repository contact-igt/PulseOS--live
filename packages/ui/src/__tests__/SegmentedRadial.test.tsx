import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedRadial } from "../SegmentedRadial";

const SEGMENTS = [
  { key: "contacted", label: "Contacted", count: 19, pct: 83, color: "#3b6fb0" },
  { key: "booked", label: "Appointment Booked", count: 15, pct: 65, color: "#2f8f8a" },
];

describe("SegmentedRadial", () => {
  it("renders the centre metric and every segment's count and percentage", () => {
    render(<SegmentedRadial title="Journey Health" segments={SEGMENTS} centerLabel="Journey Conversion" centerValue="26%" />);
    expect(screen.getByText("26%")).toBeTruthy();
    expect(screen.getByText("Journey Conversion")).toBeTruthy();
    expect(screen.getByText("Contacted")).toBeTruthy();
    expect(screen.getByText("19")).toBeTruthy();
    expect(screen.getByText("83%")).toBeTruthy();
  });

  it("invokes onSegmentClick with the segment key when a legend row is clicked", () => {
    const onSegmentClick = vi.fn();
    render(<SegmentedRadial title="Journey Health" segments={SEGMENTS} centerLabel="Journey Conversion" centerValue="26%" onSegmentClick={onSegmentClick} />);
    fireEvent.click(screen.getByTestId("radial-segment-booked"));
    expect(onSegmentClick).toHaveBeenCalledWith("booked");
  });

  it("centers the two-line label block geometrically on the ring's actual center — no arbitrary per-pixel offsets", () => {
    const { container } = render(<SegmentedRadial title="Journey Health" segments={SEGMENTS} centerLabel="Journey Conversion" centerValue="26%" />);
    const svg = container.querySelector("svg")!;
    const viewBoxWidth = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    const geometricCenter = viewBoxWidth / 2;

    const circles = Array.from(container.querySelectorAll("circle"));
    for (const circle of circles) {
      expect(Number(circle.getAttribute("cx"))).toBe(geometricCenter);
      expect(Number(circle.getAttribute("cy"))).toBe(geometricCenter);
    }

    const texts = Array.from(container.querySelectorAll("text"));
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(Number(text.getAttribute("x"))).toBe(geometricCenter);
      expect(text.getAttribute("text-anchor")).toBe("middle");
      expect(text.getAttribute("dominant-baseline")).toBe("central");
    }
    // The value line sits above center, the label line below. Each line's y
    // is its own true visual center (dominant-baseline="central" asserted
    // above), so the correct centering invariant is that the block's outer
    // edges — top of the value line, bottom of the label line — sit
    // equidistant from the ring's center, not that the two differently-sized
    // lines' y-coordinates naively average to it.
    const [valueText, labelText] = texts;
    const valueY = Number(valueText.getAttribute("y"));
    const labelY = Number(labelText.getAttribute("y"));
    const valueFontSize = Number(getComputedStyle(valueText).fontSize.replace("px", "")) || 26;
    const labelFontSize = Number(getComputedStyle(labelText).fontSize.replace("px", "")) || 11;
    expect(valueY).toBeLessThan(geometricCenter);
    expect(labelY).toBeGreaterThan(geometricCenter);
    const topEdge = valueY - valueFontSize / 2;
    const bottomEdge = labelY + labelFontSize / 2;
    expect(geometricCenter - topEdge).toBeCloseTo(bottomEdge - geometricCenter, 1);
  });
});

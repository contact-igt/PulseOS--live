import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MetricStrip } from "../MetricStrip";

afterEach(cleanup);

const cells = [
  { key: "a", label: "Appointments today", value: 9, testId: "t-a" },
  { key: "o", label: "Overdue", value: 2, testId: "t-o", attention: true },
  { key: "z", label: "Nothing overdue", value: 0, testId: "t-z", attention: true },
];

describe("MetricStrip", () => {
  it("is ONE clipped, rounded surface with solid cells (an active or hovered cell can never poke past a rounded corner)", () => {
    render(<MetricStrip cells={cells} testId="strip" layout="inline" activeKey="a" />);
    const strip = screen.getByTestId("strip");
    expect(strip.className).toContain("overflow-hidden");
    expect(strip.className).toContain("rounded-card");
    for (const id of ["t-a", "t-o", "t-z"]) expect(screen.getByTestId(id).className).not.toMatch(/bg-white\/|bg-transparent|opacity-/);
  });

  it("marks the active cell with aria-pressed, a solid tint and an underline bar (never colour alone)", () => {
    const onClick = vi.fn();
    render(<MetricStrip cells={cells.map((c) => ({ ...c, onClick }))} testId="strip" layout="inline" activeKey="a" ariaLabel="Today at a glance" />);
    expect(screen.getByRole("group", { name: "Today at a glance" })).toBeTruthy();
    const active = screen.getByTestId("t-a");
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(active.className).toContain("bg-primary-50");
    expect(active.className).toContain("inset_0_-2px_0_0");
    expect(screen.getByTestId("t-o").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("t-o"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("inline layout keeps label left and value right, vertically centred; every value has a -count test id", () => {
    render(<MetricStrip cells={cells} layout="inline" />);
    const cell = screen.getByTestId("t-a");
    expect(cell.className).toContain("items-center");
    expect(cell.className).toContain("justify-between");
    expect(screen.getByTestId("t-a-count").textContent).toBe("9");
  });

  it("an attention cell turns danger only while above zero", () => {
    render(<MetricStrip cells={cells} layout="inline" />);
    expect(screen.getByTestId("t-o-count").className).toContain("text-danger-700");
    expect(screen.getByTestId("t-z-count").className).not.toContain("text-danger-700");
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CustomFieldValueGrid } from "../CustomFieldValueGrid";

describe("CustomFieldValueGrid", () => {
  it("shows values under their configured section, in section order, with headings only when there are several", () => {
    render(
      <CustomFieldValueGrid
        fields={[
          { label: "Budget", value: "₹50,000", fieldKey: "budget", groupKey: "qualification" },
          { label: "Eye", value: "Right", fieldKey: "eye", groupKey: "service_details" },
          { label: "Insurance", value: "Star Health", fieldKey: "ins", groupKey: "service_details" },
        ]}
        testId="grid"
      />,
    );
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings).toEqual(["Service Details", "Qualification"]);
    expect(screen.getByText("Budget")).toBeTruthy();
    expect(screen.getByText("Star Health")).toBeTruthy();
  });

  it("does not repeat a heading for a single section, and tolerates values with no section (older rows)", () => {
    const { rerender } = render(<CustomFieldValueGrid fields={[{ label: "A", value: "1", groupKey: "service_details" }]} testId="grid" />);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    rerender(<CustomFieldValueGrid fields={[{ label: "A", value: "1" }, { label: "B", value: "2", groupKey: "qualification" }]} testId="grid" />);
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("B")).toBeTruthy();
  });

  it("two fields with the same label keep separate cells (keyed by field key)", () => {
    render(<CustomFieldValueGrid fields={[{ label: "Notes", value: "x", fieldKey: "n1" }, { label: "Notes", value: "y", fieldKey: "n2" }]} testId="grid" />);
    expect(screen.getAllByText("Notes")).toHaveLength(2);
  });

  it("renders nothing when there are no values", () => {
    const { container } = render(<CustomFieldValueGrid fields={[]} testId="grid" />);
    expect(container.firstChild).toBeNull();
  });
});

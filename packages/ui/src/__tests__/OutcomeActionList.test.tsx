import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DoctorTodayItem, TreatmentDefinitionVm } from "@pulseos/types";
import { OutcomeActionList } from "../OutcomeActionList";

const item: DoctorTodayItem = { appointmentId: "a1", patientName: "Sneha Kamath", time: "2026-09-29T10:00:00.000Z", status: "completed" };
const catalog: TreatmentDefinitionVm[] = [
  { id: "d-lasik", specialtyKey: "LASER_VISION_CORRECTION", key: "LASIK", label: "LASIK", defaultEstimatedValue: 90_000, sortOrder: 1 },
  { id: "d-prk", specialtyKey: "LASER_VISION_CORRECTION", key: "PRK", label: "PRK", defaultEstimatedValue: 70_000, sortOrder: 3 },
];

describe("OutcomeActionList treatment picker", () => {
  it("without a catalog prop, Treatment Advised records immediately (legacy behaviour)", () => {
    const onRecord = vi.fn();
    render(<OutcomeActionList items={[item]} onRecord={onRecord} />);
    fireEvent.click(screen.getByTestId("outcome-TREATMENT_ADVISED-a1"));
    expect(onRecord).toHaveBeenCalledWith("a1", "TREATMENT_ADVISED");
  });

  it("with a catalog, Treatment Advised opens a select of catalog procedures and records the chosen definition", () => {
    const onRecord = vi.fn();
    render(<OutcomeActionList items={[item]} onRecord={onRecord} getTreatmentOptions={() => catalog} />);
    fireEvent.click(screen.getByTestId("outcome-TREATMENT_ADVISED-a1"));
    expect(onRecord).not.toHaveBeenCalled();
    const select = screen.getByTestId("treatment-select-a1") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual(["Select a treatment", "LASIK", "PRK"]);
    expect((screen.getByTestId("treatment-confirm-a1") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "d-prk" } });
    fireEvent.click(screen.getByTestId("treatment-confirm-a1"));
    expect(onRecord).toHaveBeenCalledWith("a1", "TREATMENT_ADVISED", { treatmentDefinitionId: "d-prk" });
  });

  it("falls back to a free-text label only when the catalog is empty", () => {
    const onRecord = vi.fn();
    render(<OutcomeActionList items={[item]} onRecord={onRecord} getTreatmentOptions={() => []} />);
    fireEvent.click(screen.getByTestId("outcome-TREATMENT_ADVISED-a1"));
    expect(screen.queryByTestId("treatment-select-a1")).toBeNull();
    fireEvent.change(screen.getByTestId("treatment-text-a1"), { target: { value: "Custom procedure" } });
    fireEvent.click(screen.getByTestId("treatment-confirm-a1"));
    expect(onRecord).toHaveBeenCalledWith("a1", "TREATMENT_ADVISED", { treatmentLabel: "Custom procedure" });
  });

  it("outcomes that create no treatment record straight away even with a catalog", () => {
    const onRecord = vi.fn();
    render(<OutcomeActionList items={[item]} onRecord={onRecord} getTreatmentOptions={() => catalog} />);
    fireEvent.click(screen.getByTestId("outcome-CONSULTED-a1"));
    expect(onRecord).toHaveBeenCalledWith("a1", "CONSULTED");
  });

  it("cancel closes the picker without recording", () => {
    const onRecord = vi.fn();
    render(<OutcomeActionList items={[item]} onRecord={onRecord} getTreatmentOptions={() => catalog} />);
    fireEvent.click(screen.getByTestId("outcome-DECISION_PENDING-a1"));
    fireEvent.click(screen.getByTestId("treatment-cancel-a1"));
    expect(screen.queryByTestId("treatment-select-a1")).toBeNull();
    expect(onRecord).not.toHaveBeenCalled();
  });
});

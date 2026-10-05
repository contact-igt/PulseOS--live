import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";
import { TreatmentPipelineBoard } from "../TreatmentPipelineBoard";

function row(id: string, status: TreatmentStatus): TreatmentRow {
  return {
    id, patientId: `p-${id}`, patientName: `Patient ${id}`, journeyId: `j-${id}`, doctorName: "Dr. Demo", service: "Cataract",
    treatmentDefinitionId: null, treatmentLabel: "Cataract Surgery", estimatedValue: 40_000, status, ownerName: null,
    nextActionDueAt: null, lastContactAt: null, plannedDate: null,
  };
}

const rows = [row("a", "ADVISED"), row("b", "SCHEDULED"), row("c", "COMPLETED"), row("d", "DECLINED")];

describe("TreatmentPipelineBoard", () => {
  it("without onMove (no MANAGE_TREATMENT) is read-only: no move controls, a quiet hint, cards still open the journey", () => {
    const onOpen = vi.fn();
    render(<TreatmentPipelineBoard rows={rows} timeZone="Asia/Kolkata" onOpen={onOpen} />);
    expect(screen.getByTestId("kanban-board").getAttribute("data-readonly")).toBe("true");
    expect(screen.queryAllByTestId(/^kanban-move-/)).toHaveLength(0);
    expect(screen.getByTestId("treatment-board-readonly").textContent).toMatch(/Read-only/);
    screen.getByRole("button", { name: "Patient a, Cataract Surgery" }).click();
    expect(onOpen).toHaveBeenCalledWith(rows[0]);
  });

  it("with onMove shows a Move control only on cards that have a valid board move", () => {
    render(<TreatmentPipelineBoard rows={rows} timeZone="Asia/Kolkata" onOpen={() => {}} onMove={async () => {}} />);
    expect(screen.getByTestId("kanban-board").getAttribute("data-readonly")).toBe("false");
    expect(screen.getByTestId("kanban-move-a")).toBeTruthy();
    expect(screen.getByTestId("kanban-move-b")).toBeTruthy();
    expect(screen.queryByTestId("kanban-move-c")).toBeNull();
    expect(screen.queryByTestId("kanban-move-d")).toBeNull();
  });

  it("has one column per state and every row lands in exactly one", () => {
    render(<TreatmentPipelineBoard rows={rows} timeZone="Asia/Kolkata" onOpen={() => {}} />);
    for (const r of rows) expect(within(screen.getByTestId(`kanban-col-${r.status}`)).getByTestId(`kanban-card-${r.id}`)).toBeTruthy();
    expect(screen.getAllByTestId(/^kanban-card-/)).toHaveLength(rows.length);
  });
});

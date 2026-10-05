import { describe, expect, it } from "vitest";
import { ApiError } from "@pulseos/api-client";
import type { TreatmentRow, TreatmentStatus } from "@pulseos/types";
import {
  BOARD_MOVES,
  boardColumnKeys,
  countByStatus,
  moveErrorMessage,
  readTreatmentFilters,
  scheduledProcedures,
} from "../pipeline";

function row(id: string, status: TreatmentStatus, plannedDate: string | null = null): TreatmentRow {
  return {
    id,
    patientId: `p-${id}`,
    patientName: `Patient ${id}`,
    journeyId: `j-${id}`,
    doctorName: null,
    service: "Cataract",
    treatmentDefinitionId: null,
    treatmentLabel: "Cataract Surgery",
    estimatedValue: 40_000,
    status,
    ownerName: null,
    nextActionDueAt: null,
    lastContactAt: null,
    plannedDate,
  };
}

// Mirrors VALID_TRANSITIONS in apps/api/src/domain/treatment/treatment.service.ts.
const SERVER_VALID: Record<TreatmentStatus, TreatmentStatus[]> = {
  ADVISED: ["DECISION_PENDING", "ACCEPTED", "DECLINED", "CANCELLED"],
  DECISION_PENDING: ["ACCEPTED", "DECLINED", "CANCELLED"],
  ACCEPTED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
  LOST: [],
};

describe("treatment pipeline board", () => {
  it("only offers moves the server accepts, and never a destructive one (Decline/Cancel keep their confirmation in the table)", () => {
    for (const [from, targets] of Object.entries(BOARD_MOVES) as [TreatmentStatus, TreatmentStatus[]][]) {
      for (const to of targets) {
        expect(SERVER_VALID[from]).toContain(to);
        expect(["DECLINED", "CANCELLED", "LOST"]).not.toContain(to);
      }
    }
    expect(BOARD_MOVES.COMPLETED ?? []).toEqual([]);
    expect(BOARD_MOVES.ADVISED).toEqual(["DECISION_PENDING", "ACCEPTED"]);
  });

  it("has a column for every status present, so no row is ever dropped from the board", () => {
    const rows = [row("1", "ADVISED"), row("2", "LOST"), row("3", "COMPLETED")];
    const keys = boardColumnKeys(rows);
    for (const r of rows) expect(keys).toContain(r.status);
    expect(keys.slice(0, 5)).toEqual(["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED"]);
    expect(boardColumnKeys([row("1", "ADVISED")])).not.toContain("LOST");
  });

  it("column counts add up to the table's row count", () => {
    const rows = [row("1", "ADVISED"), row("2", "ADVISED"), row("3", "SCHEDULED"), row("4", "DECLINED")];
    const counts = countByStatus(rows);
    expect(counts).toMatchObject({ ADVISED: 2, SCHEDULED: 1, DECLINED: 1 });
    expect(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(rows.length);
  });

  it("turns a server rejection into a clear, specific inline message", () => {
    expect(moveErrorMessage(new ApiError(409, "invalid_transition"), "Accepted")).toMatch(/changed elsewhere/i);
    expect(moveErrorMessage(new ApiError(409, "conflict"), "Accepted")).toMatch(/changed elsewhere/i);
    expect(moveErrorMessage(new ApiError(403, "forbidden"), "Accepted")).toMatch(/not change/i);
    expect(moveErrorMessage(new ApiError(404, "treatment_not_found"), "Accepted")).toMatch(/no longer exists/i);
    expect(moveErrorMessage(new TypeError("Failed to fetch"), "Accepted")).toMatch(/could not save/i);
  });
});

describe("procedure calendar", () => {
  it("shows ONLY Scheduled treatments that have a planned date, and counts the undated ones", () => {
    const rows = [
      row("a", "SCHEDULED", "2026-10-04T04:30:00.000Z"),
      row("b", "SCHEDULED", null),
      row("c", "ACCEPTED", "2026-10-06T04:30:00.000Z"),
      row("d", "COMPLETED", "2026-09-01T04:30:00.000Z"),
    ];
    const { events, undated } = scheduledProcedures(rows);
    expect(events.map((e) => e.id)).toEqual(["a"]);
    expect(events[0]).toMatchObject({ start: "2026-10-04T04:30:00.000Z", title: "Patient a", subtitle: "Cataract Surgery", status: "Scheduled" });
    expect(events[0].end ?? null).toBeNull();
    expect(undated).toBe(1);
  });
});

describe("treatment URL state", () => {
  it("reads filters from the URL and ignores unknown states", () => {
    expect(readTreatmentFilters(new URLSearchParams("state=SCHEDULED&service=Cataract&doctor=d1&owner=o1&procedure=p1&view=pipeline"))).toEqual({
      status: "SCHEDULED",
      service: "Cataract",
      doctorId: "d1",
      ownerId: "o1",
      procedureId: "p1",
    });
    expect(readTreatmentFilters(new URLSearchParams("state=BOGUS")).status).toBe("");
  });
});

describe("Procedure Calendar uses the scheduled date only (not the completion date)", () => {
  const row = (over: Partial<TreatmentRow>): TreatmentRow =>
    ({ id: "t", patientId: "p", patientName: "Asha", journeyId: "j", doctorName: null, treatmentLabel: "Cataract", estimatedValue: 0, status: "SCHEDULED", ownerName: null, nextActionDueAt: null, lastContactAt: null, plannedDate: null, ...over }) as TreatmentRow;

  it("a scheduled procedure sits on its scheduled-for time; a completed one is not on the calendar even though it has a completion time", () => {
    const { events, undated } = scheduledProcedures([
      row({ id: "s", status: "SCHEDULED", plannedDate: "2026-10-10T05:30:00Z", completedAt: null }),
      row({ id: "c", status: "COMPLETED", plannedDate: "2026-10-01T05:30:00Z", completedAt: "2026-10-03T07:00:00Z" }),
      row({ id: "legacy", status: "SCHEDULED", plannedDate: null }),
    ]);
    expect(events.map((e) => [e.id, e.start])).toEqual([["s", "2026-10-10T05:30:00Z"]]);
    expect(undated).toBe(1); // a legacy scheduled row without a date is counted, not placed on an invented day
  });
});

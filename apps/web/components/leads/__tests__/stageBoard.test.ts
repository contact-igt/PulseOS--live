import { describe, expect, it } from "vitest";
import type { JourneyStage, LeadRow } from "@pulseos/types";
import { STAGE_COLUMNS, countByStage } from "../stageBoard";

const row = (id: string, stage: JourneyStage) => ({ id, stage }) as LeadRow;

describe("leads stage board", () => {
  it("has one column per journey stage, in operational order, ending with Lost", () => {
    expect(STAGE_COLUMNS.map((c) => c.key)).toEqual(["enquiry", "contacted", "booked", "attended", "consulted", "treatment_advised", "scheduled", "completed", "lost"]);
  });

  it("counts every row exactly once, so column totals equal the table's row count", () => {
    const rows = [row("a", "enquiry"), row("b", "enquiry"), row("c", "lost"), row("d", "booked")];
    const counts = countByStage(rows);
    expect(counts).toMatchObject({ enquiry: 2, booked: 1, lost: 1, contacted: 0 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length);
  });
});

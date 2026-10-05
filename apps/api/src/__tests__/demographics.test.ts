import { describe, expect, it } from "vitest";
import { ageGroupOf, buildAgeDimension, buildFieldDimension } from "../domain/dashboard/demographics.js";

describe("age groups are derived, never stored", () => {
  it("buckets by whole years, with the edges in the right group", () => {
    expect([0, 17, 18, 34, 35, 49, 50, 64, 65, 99].map((a) => ageGroupOf(a)?.label)).toEqual(["Under 18", "Under 18", "18–34", "18–34", "35–49", "35–49", "50–64", "50–64", "65 and over", "65 and over"]);
    expect(ageGroupOf(null)).toBeNull();
    expect(ageGroupOf(-3)).toBeNull();
  });
  it("counts only people whose age is known and leaves 'unknown' out of the chart", () => {
    const d = buildAgeDimension([20, 22, 40, null, null, 70])!;
    expect(d.answered).toBe(4);
    expect(d.rows).toEqual([{ label: "18–34", count: 2, pct: 50 }, { label: "35–49", count: 1, pct: 25 }, { label: "65 and over", count: 1, pct: 25 }]);
  });
  it("has no dimension at all when nobody has an age (no empty chart)", () => {
    expect(buildAgeDimension([null, null])).toBeNull();
    expect(buildAgeDimension([])).toBeNull();
  });
});

describe("field dimensions come only from real answers", () => {
  it("counts a choice field, biggest first, with shares of the people who answered", () => {
    const d = buildFieldDimension({ key: "gender", label: "Gender", fieldType: "SELECT" }, ["Female", "Female", "Male", " Female "])!;
    expect(d).toMatchObject({ key: "gender", label: "Gender", answered: 4 });
    expect(d.rows).toEqual([{ label: "Female", count: 3, pct: 75 }, { label: "Male", count: 1, pct: 25 }]);
  });
  it("shows a free-text field like Area only because answers REPEAT; a unique identifier (a UID) is never a chart", () => {
    expect(buildFieldDimension({ key: "area", label: "Area / Locality", fieldType: "TEXT" }, ["Ashok Vihar", "Ashok Vihar", "Pitampura", "Ashok Vihar"])?.rows[0]).toEqual({ label: "Ashok Vihar", count: 3, pct: 75 });
    expect(buildFieldDimension({ key: "uid", label: "Namokar UID", fieldType: "TEXT" }, ["NK-1", "NK-2", "NK-3", "NK-4"])).toBeNull();
  });
  it("no answers means no dimension; a long tail folds into 'Other'", () => {
    expect(buildFieldDimension({ key: "g", label: "G", fieldType: "SELECT" }, ["", "  "])).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => `Area ${i}`).flatMap((a, i) => Array.from({ length: 12 - i }, () => a));
    const d = buildFieldDimension({ key: "a", label: "A", fieldType: "SELECT" }, many)!;
    expect(d.rows).toHaveLength(9);
    expect(d.rows[8]!.label).toBe("Other");
    expect(d.rows.reduce((n, r) => n + r.count, 0)).toBe(many.length);
  });
});

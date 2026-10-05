import { describe, expect, it } from "vitest";
import { splitInProgress } from "../trend";

const day = (key: string) => ({ key, to: key, days: 1, partial: false });

describe("splitInProgress (the running bucket is drawn apart, never as a real drop)", () => {
  it("moves the bucket containing today onto a separate open segment joined to the last complete one", () => {
    const buckets = [day("2026-09-28"), day("2026-09-29"), day("2026-09-30")];
    expect(splitInProgress(buckets, [5, 7, 1], "2026-09-30")).toEqual({
      openIndex: 2,
      closed: [5, 7, null],
      open: [null, 7, 1],
    });
  });

  it("finds today inside a multi-day block", () => {
    const buckets = [{ key: "2026-09-17", to: "2026-09-23", days: 7, partial: false }, { key: "2026-09-24", to: "2026-09-30", days: 7, partial: false }];
    expect(splitInProgress(buckets, [20, 9], "2026-09-27").openIndex).toBe(1);
  });

  it("leaves a fully past range untouched", () => {
    const buckets = [day("2026-08-01"), day("2026-08-02")];
    expect(splitInProgress(buckets, [3, 4], "2026-09-30")).toEqual({ openIndex: -1, closed: [3, 4], open: [null, null] });
  });

  it("a single in-progress bucket has no complete neighbour to join", () => {
    expect(splitInProgress([day("2026-09-30")], [2], "2026-09-30")).toEqual({ openIndex: 0, closed: [null], open: [2] });
  });
});

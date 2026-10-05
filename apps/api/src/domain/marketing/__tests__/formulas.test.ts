import { describe, expect, it } from "vitest";
import { costPer, roas, allocatedAcquisitionCost } from "../formulas.js";

describe("attribution formulas", () => {
  describe("costPer (generic cost-per-outcome)", () => {
    it("divides spend by outcome count", () => {
      expect(costPer(10000, 20)).toBe(500);
    });

    it("returns null when the outcome count is zero (never Infinity/NaN)", () => {
      expect(costPer(10000, 0)).toBeNull();
    });

    it("returns null when spend is zero and count is zero", () => {
      expect(costPer(0, 0)).toBeNull();
    });

    it("returns 0 when spend is zero but outcomes exist", () => {
      expect(costPer(0, 5)).toBe(0);
    });
  });

  describe("roas (attributed revenue / spend)", () => {
    it("computes a ratio", () => {
      expect(roas(50000, 10000)).toBe(5);
    });

    it("returns null when spend is zero (never Infinity)", () => {
      expect(roas(50000, 0)).toBeNull();
    });

    it("returns 0 when revenue is zero but spend was incurred", () => {
      expect(roas(0, 10000)).toBe(0);
    });
  });

  describe("allocatedAcquisitionCost (spend-at-risk allocation)", () => {
    it("equals campaign spend divided by campaign enquiry count", () => {
      expect(allocatedAcquisitionCost(20000, 40)).toBe(500);
    });

    it("returns null when the campaign has no enquiries yet", () => {
      expect(allocatedAcquisitionCost(20000, 0)).toBeNull();
    });
  });
});

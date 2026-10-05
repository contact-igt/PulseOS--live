import { describe, expect, it } from "vitest";
import { normalizePhone } from "../phone.js";

describe("normalizePhone", () => {
  it("normalizes a +91-prefixed Indian mobile number", () => {
    const result = normalizePhone("+91 98765 43210", "IN");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+919876543210");
    expect(result.country).toBe("IN");
    expect(result.raw).toBe("+91 98765 43210");
  });

  it("normalizes a bare local Indian format (no country code) using the tenant's default region", () => {
    const result = normalizePhone("9876543210", "IN");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+919876543210");
    expect(result.country).toBe("IN");
  });

  it("normalizes an Indian number with spaces", () => {
    const result = normalizePhone("98765 43210", "IN");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+919876543210");
  });

  it("normalizes a US number with parentheses and a dash, given a US default region", () => {
    const result = normalizePhone("(415) 555-2671", "US");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+14155552671");
    expect(result.country).toBe("US");
  });

  it("normalizes an Indian number with a leading trunk zero", () => {
    const result = normalizePhone("09876543210", "IN");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+919876543210");
  });

  it("normalizes an explicit international number regardless of the tenant's default region", () => {
    const result = normalizePhone("+14155552671", "IN");
    expect(result.valid).toBe(true);
    expect(result.e164).toBe("+14155552671");
    expect(result.country).toBe("US");
  });

  it("marks an invalid/too-short number as invalid without throwing, and preserves the raw input", () => {
    const result = normalizePhone("12345", "IN");
    expect(result.valid).toBe(false);
    expect(result.e164).toBeNull();
    expect(result.raw).toBe("12345");
  });

  it("marks garbage input as invalid without throwing", () => {
    const result = normalizePhone("not-a-phone-number", "IN");
    expect(result.valid).toBe(false);
    expect(result.e164).toBeNull();
  });

  it("two different raw representations of the same number normalize to the same E.164 value (enables identity matching)", () => {
    const a = normalizePhone("+91 98765 43210", "IN");
    const b = normalizePhone("09876543210", "IN");
    expect(a.e164).toBe(b.e164);
  });
});

import { describe, expect, it } from "vitest";
import { buildPayload, emptyForm, firstStepWithError, validateStep, type SignupForm } from "../signupForm";

const filled = (over: Partial<SignupForm> = {}): SignupForm => ({
  ...emptyForm(),
  fullName: "Asha Verma",
  email: "asha@sunrise.example",
  phone: "+91 98765 43210",
  password: "Correct-Horse-9",
  organizationName: "Sunrise Eye Care",
  industry: "Healthcare",
  organizationType: "Eye Hospital",
  department: "Ophthalmology",
  addressLine: "12 MG Road",
  city: "Bengaluru",
  state: "Karnataka",
  pinCode: "560038",
  discoverySource: "Google",
  ...over,
});

describe("validateStep", () => {
  it("accepts a complete form on every step", () => {
    for (const step of [1, 2, 3, 4, 5] as const) expect(validateStep(step, filled())).toEqual({});
  });

  it("step 1 needs a name, a real email, a phone and a 10+ character password that is not the email", () => {
    expect(Object.keys(validateStep(1, emptyForm())).sort()).toEqual(["email", "fullName", "password", "phone"]);
    expect(validateStep(1, filled({ email: "nope" })).email).toBeTruthy();
    expect(validateStep(1, filled({ phone: "12345" })).phone).toBeTruthy();
    expect(validateStep(1, filled({ password: "short" })).password).toBeTruthy();
    expect(validateStep(1, filled({ password: "asha@sunrise.example" })).password).toBeTruthy();
  });

  it("step 2 needs healthcare details only for Healthcare", () => {
    expect(validateStep(2, filled({ organizationType: undefined, department: undefined })).organizationType).toBeTruthy();
    expect(validateStep(2, filled({ organizationType: undefined, department: undefined })).department).toBeTruthy();
    expect(validateStep(2, filled({ industry: "Other", organizationType: undefined, department: undefined }))).toEqual({});
    expect(validateStep(2, filled({ organizationName: " " })).organizationName).toBeTruthy();
  });

  it("step 3 needs an address, city, state and a 6-digit PIN", () => {
    expect(Object.keys(validateStep(3, filled({ addressLine: "", city: "", state: "", pinCode: "12" }))).sort()).toEqual(["addressLine", "city", "pinCode", "state"]);
  });

  it("step 4 needs a discovery source", () => {
    expect(validateStep(4, filled({ discoverySource: undefined })).discoverySource).toBeTruthy();
  });
});

describe("firstStepWithError", () => {
  it("finds the earliest step a server field belongs to", () => {
    expect(firstStepWithError(["pinCode", "email"])).toBe(1);
    expect(firstStepWithError(["pinCode"])).toBe(3);
    expect(firstStepWithError(["discoverySource"])).toBe(4);
    expect(firstStepWithError(["somethingElse"])).toBe(5);
  });
});

describe("buildPayload", () => {
  it("trims, defaults the country, drops healthcare fields for other industries and never includes a tenant id", () => {
    const p = buildPayload(filled({ fullName: "  Asha Verma ", industry: "Other", organizationType: "Eye Hospital", department: "Ophthalmology", discoveryNotes: "  ", locality: "" }));
    expect(p).toMatchObject({ fullName: "Asha Verma", industry: "Other", country: "India", edition: "V1" });
    expect(p.organizationType).toBeUndefined();
    expect(p.department).toBeUndefined();
    expect(p.discoveryNotes).toBeUndefined();
    expect(p.locality).toBeUndefined();
    expect(Object.keys(p)).not.toContain("tenantId");
  });
});

import type { SignupInput } from "@pulseos/types";
import { SIGNUP_DEPARTMENTS, SIGNUP_DISCOVERY_SOURCES, SIGNUP_EDITIONS, SIGNUP_INDUSTRIES, SIGNUP_ORGANIZATION_TYPES } from "@pulseos/types";

export { SIGNUP_DEPARTMENTS, SIGNUP_DISCOVERY_SOURCES, SIGNUP_EDITIONS, SIGNUP_INDUSTRIES, SIGNUP_ORGANIZATION_TYPES };

/** Everything the sign-up wizard collects, as the person typed it. The API re-validates all of it. */
export interface SignupForm {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  organizationName: string;
  industry: SignupInput["industry"];
  organizationType: SignupInput["organizationType"];
  department: SignupInput["department"];
  addressLine: string;
  locality: string;
  city: string;
  state: string;
  pinCode: string;
  country: string;
  discoverySource: SignupInput["discoverySource"] | undefined;
  discoveryNotes: string;
  edition: SignupInput["edition"];
}

export type SignupStep = 1 | 2 | 3 | 4 | 5;
export type FieldErrors = Partial<Record<keyof SignupForm, string>>;

export const emptyForm = (): SignupForm => ({
  fullName: "",
  email: "",
  phone: "",
  password: "",
  organizationName: "",
  industry: "Healthcare",
  organizationType: undefined,
  department: undefined,
  addressLine: "",
  locality: "",
  city: "",
  state: "",
  pinCode: "",
  country: "India",
  discoverySource: undefined,
  discoveryNotes: "",
  edition: "V1",
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Light, friendly checks for one step. The server is the authority and re-checks everything. */
export function validateStep(step: SignupStep, f: SignupForm): FieldErrors {
  const e: FieldErrors = {};
  if (step === 1) {
    if (f.fullName.trim().length < 2) e.fullName = "Enter your full name";
    if (!EMAIL.test(f.email.trim())) e.email = "Enter a valid work email";
    if (f.phone.replace(/\D/g, "").length < 8) e.phone = "Enter a phone number we can reach you on";
    if (f.password.length < 10) e.password = "Use at least 10 characters";
    else if (f.password.toLowerCase() === f.email.trim().toLowerCase()) e.password = "The password must not be your email";
  }
  if (step === 2) {
    if (f.organizationName.trim().length < 2) e.organizationName = "Enter your hospital or organization name";
    if (f.industry === "Healthcare") {
      if (!f.organizationType) e.organizationType = "Choose the organization type";
      if (!f.department) e.department = "Choose a department";
    }
  }
  if (step === 3) {
    if (f.addressLine.trim().length < 3) e.addressLine = "Enter the address";
    if (f.city.trim().length < 2) e.city = "Enter the city";
    if (f.state.trim().length < 2) e.state = "Enter the state";
    if (!/^\d{6}$/.test(f.pinCode.trim())) e.pinCode = "PIN code must be 6 digits";
  }
  if (step === 4) {
    if (!f.discoverySource) e.discoverySource = "Tell us how you heard about PulseOS";
  }
  return e;
}

const STEP_OF_FIELD: Partial<Record<keyof SignupForm, SignupStep>> = {
  fullName: 1, email: 1, phone: 1, password: 1,
  organizationName: 2, industry: 2, organizationType: 2, department: 2,
  addressLine: 3, locality: 3, city: 3, state: 3, pinCode: 3, country: 3,
  discoverySource: 4, discoveryNotes: 4,
};

/** The earliest step that owns any of the fields the server complained about (step 5 when none is recognised). */
export function firstStepWithError(fields: string[]): SignupStep {
  const steps = fields.map((k) => STEP_OF_FIELD[k as keyof SignupForm]).filter((s): s is SignupStep => !!s);
  return steps.length ? (Math.min(...steps) as SignupStep) : 5;
}

/** The request body: trimmed, healthcare details only for Healthcare, and never a tenant id (the server creates that). */
export function buildPayload(f: SignupForm): SignupInput {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  const healthcare = f.industry === "Healthcare";
  return {
    fullName: f.fullName.trim(),
    email: f.email.trim(),
    phone: f.phone.trim(),
    password: f.password,
    organizationName: f.organizationName.trim(),
    industry: f.industry,
    organizationType: healthcare ? f.organizationType : undefined,
    department: healthcare ? f.department : undefined,
    addressLine: f.addressLine.trim(),
    locality: opt(f.locality),
    city: f.city.trim(),
    state: f.state.trim(),
    pinCode: f.pinCode.trim(),
    country: f.country.trim() || "India",
    discoverySource: f.discoverySource!,
    discoveryNotes: opt(f.discoveryNotes),
    edition: f.edition,
  };
}

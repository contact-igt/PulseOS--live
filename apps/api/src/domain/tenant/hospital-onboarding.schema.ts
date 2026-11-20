import { z } from "zod";
import { SIGNUP_DEPARTMENTS, SIGNUP_DISCOVERY_SOURCES, SIGNUP_EDITIONS, SIGNUP_INDUSTRIES, SIGNUP_ORGANIZATION_TYPES, type Edition } from "@pulseos/types";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

export const hospitalCreationSchema = z
  .object({
    fullName: text(2, 80),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: text(6, 24),
    organizationName: text(2, 120),
    industry: z.enum(SIGNUP_INDUSTRIES),
    organizationType: z.enum(SIGNUP_ORGANIZATION_TYPES).optional(),
    department: z.enum(SIGNUP_DEPARTMENTS).optional(),
    addressLine: text(3, 160),
    locality: optionalText(80),
    city: text(2, 80),
    state: text(2, 80),
    pinCode: z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"),
    country: text(2, 60).default("India"),
    discoverySource: z.enum(SIGNUP_DISCOVERY_SOURCES),
    discoveryNotes: optionalText(300),
    edition: z.enum(SIGNUP_EDITIONS).default("V1"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.industry === "Healthcare") {
      if (!v.organizationType) ctx.addIssue({ code: "custom", path: ["organizationType"], message: "Choose the organization type" });
      if (!v.department) ctx.addIssue({ code: "custom", path: ["department"], message: "Choose a department" });
    }
  });

export const ONBOARDING_EDITION: Record<z.infer<typeof hospitalCreationSchema>["edition"], Edition> = { V1: "BETA_V1_CORE", V2: "BETA_V2_GROWTH" };

import type { Role } from "@pulseos/types";

// Demo environments are separate TENANTS, each with its own seeded users —
// Dev Login resolves a (environment, role) pair to that tenant's real user
// and creates a normal session for it. Nothing here filters data by tenant;
// isolation comes entirely from the session's tenantId, exactly as for a
// password login.

export const DEMO_LOGIN_ROLES: { role: Role; label: string; emailSlug: string }[] = [
  { role: "SUPER_ADMIN", label: "Super Admin", emailSlug: "superadmin" },
  { role: "HOSPITAL_ADMIN", label: "Admin", emailSlug: "admin" },
  { role: "DOCTOR", label: "Doctor", emailSlug: "doctor" },
  { role: "FRONT_DESK", label: "Staff · Front Desk", emailSlug: "frontdesk" },
  { role: "PATIENT_COORDINATOR", label: "Staff · Patient Coordinator", emailSlug: "coordinator" },
];

/** Every seeded staff account per environment: the four Dev Login roles plus a second doctor. */
export const DEMO_STAFF_SLUGS = ["superadmin", "admin", "doctor", "doctor2", "frontdesk", "coordinator"] as const;

/** Namokar V1 is a one-doctor clinic with two coordinators (Shivani, Sushil): its accounts differ from the shared list above. */
export const NAMOKAR_STAFF_SLUGS = ["superadmin", "admin", "doctor", "frontdesk", "coordinator", "coordinator2"] as const;

/** Namokar V2 Pilot is a clean tenant (configuration only): one doctor, one front desk, two named coordinators. */
export const NAMOKAR_V2_STAFF_SLUGS = ["superadmin", "admin", "doctor", "frontdesk", "shivani", "sushil"] as const;

export const DEMO_ENVIRONMENTS = [
  { key: "gynecology", label: "Gynecology V2", tenantName: "PulseOS Gynecology Demo", emailPrefix: "gyn", edition: "BETA_V2_GROWTH" },
  { key: "ophthalmology", label: "Ophthalmology V2", tenantName: "PulseOS Ophthalmology Demo", emailPrefix: "eye", edition: "BETA_V2_GROWTH" },
  { key: "ophthalmology-v1", label: "Ophthalmology V1", tenantName: "PulseOS Ophthalmology V1 Demo", emailPrefix: "eyev1", edition: "BETA_V1_CORE" },
  // The Namokar Eye & Oculoplasty Centre pilot workspace (fictional data, today-relative). Its own sign-in page is /login/namokar-v1.
  { key: "namokar", label: "Namokar V1 Demo", tenantName: "Namokar Eye & Oculoplasty Centre", emailPrefix: "namokar", edition: "BETA_V1_CORE" },
  // The clean Namokar pilot workspace: configuration and staff only, no patients or activity. Sign-in page /login/namokar-v2.
  { key: "namokar-v2", label: "Namokar V2 Pilot", tenantName: "Namokar Eye & Oculoplasty Centre (Pilot)", emailPrefix: "namokarv2", edition: "BETA_V1_CORE" },
] as const;

export type DemoEnvironmentKey = (typeof DEMO_ENVIRONMENTS)[number]["key"];

export const DEFAULT_DEMO_ENVIRONMENT: DemoEnvironmentKey = "gynecology";

export function demoEmail(environment: DemoEnvironmentKey, emailSlug: string): string {
  const env = DEMO_ENVIRONMENTS.find((e) => e.key === environment);
  if (!env) throw new Error(`unknown demo environment: ${environment}`);
  return `${env.emailPrefix}.${emailSlug}@pulseos.local`;
}

/** Email of the seeded demo user for a role in an environment, or null for roles with no demo account (e.g. SUPER_ADMIN). */
export function demoEmailForRole(environment: DemoEnvironmentKey, role: Role): string | null {
  const entry = DEMO_LOGIN_ROLES.find((r) => r.role === role);
  // Namokar V2 has no generic "coordinator" account: Dev Login's coordinator is Shivani.
  if (environment === "namokar-v2" && role === "PATIENT_COORDINATOR") return demoEmail(environment, "shivani");
  return entry ? demoEmail(environment, entry.emailSlug) : null;
}

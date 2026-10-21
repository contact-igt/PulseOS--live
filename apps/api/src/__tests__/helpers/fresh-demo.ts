import { randomUUID } from "node:crypto";
import { hashPassword } from "../../domain/auth/auth.service.js";
import { seedNamokarTenant, type DemoCopy } from "../../seed/demo/namokar.js";
import { OPHTHALMOLOGY_V1, OPHTHALMOLOGY_V2, seedOphthalmologyTenant, type OphthalmologyVariant } from "../../seed/demo/ophthalmology.js";
import { DEMO_TIMEZONE } from "../../seed/demo/demo-clock.js";

// Seed-guarantee tests check that a demo hospital tells its same-day story ("8-12 enquiries today", "a callback due later
// today"). Data is placed relative to the moment it is built, and the API decides "today" from the server clock - so a
// demo seeded yesterday (or a suite that crosses midnight) would fail for reasons that have nothing to do with the code.
// These helpers build a FRESH copy of the demo at the test's own start, from the very same builders the seed uses, and
// never start building in the last minutes of the hospital day, so one test can never straddle midnight.

/** Minutes until the next hospital-local midnight. */
export function minutesToHospitalMidnight(now: Date = new Date(), tz = DEMO_TIMEZONE): number {
  const [h, m, s] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now).split(":").map(Number);
  return 24 * 60 - (h! * 60 + m! + s! / 60);
}

/** If the hospital day ends within `marginMinutes`, wait until just after midnight (bounded by the margin). */
export async function awayFromHospitalMidnight(marginMinutes = 3): Promise<void> {
  const left = minutesToHospitalMidnight();
  if (left < marginMinutes) await new Promise((r) => setTimeout(r, Math.ceil(left * 60_000) + 5_000));
}

/** Seed-guarantee hooks may wait for midnight to pass, then build a whole demo hospital. */
export const FRESH_DEMO_HOOK_TIMEOUT = 4 * 60_000;

function copyIdentity(base: string, slugBase: string): DemoCopy {
  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  return { tenantName: `${base} (fresh ${tag})`, loginSlug: `${slugBase}-${tag.toLowerCase()}`, tag: `FRESH${tag}` };
}

/** A copy's staff have their own addresses: <loginSlug>.<role slug>@pulseos.local (never the shared demo's). */
export type FreshDemo = DemoCopy & { tenantId: string; email: (slug: string) => string };
const emailFor = (loginSlug: string) => (slug: string) => `${loginSlug}.${slug}@pulseos.local`;

export async function freshNamokarDemo(password: string): Promise<FreshDemo> {
  const copy = copyIdentity("Namokar Eye & Oculoplasty Centre", "namokar-fresh");
  const { tenantId } = await seedNamokarTenant(await hashPassword(password), copy);
  return { ...copy, tenantId, email: emailFor(copy.loginSlug) };
}

export async function freshOphthalmologyDemo(password: string, base: "V1" | "V2"): Promise<FreshDemo & { variant: OphthalmologyVariant }> {
  const original = base === "V1" ? OPHTHALMOLOGY_V1 : OPHTHALMOLOGY_V2;
  const copy = copyIdentity(original.tenantName, `${original.loginSlug}-fresh`);
  const variant: OphthalmologyVariant = { ...original, tenantName: copy.tenantName, loginSlug: copy.loginSlug, tag: copy.tag, formId: `${original.formId}-${copy.tag.toLowerCase()}`, emailPrefix: copy.loginSlug };
  const r = await seedOphthalmologyTenant(await hashPassword(password), variant);
  return { ...copy, tenantId: r.tenantId, variant, email: emailFor(copy.loginSlug) };
}

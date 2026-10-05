import { z } from "zod";
import { LOGIN_LOGO_PATH_PATTERN, type TenantLoginBranding } from "@pulseos/types";

// The public sign-in configuration of a hospital, read on the SERVER by slug and validated before anything is rendered.
// The shape is the whole contract: short text and one logo file of this app's own /brand folder. Anything else the API might
// ever add is dropped (strip), and a value outside its limit makes the whole answer invalid - the page then says "not found"
// rather than render something unexpected.

const text = (max: number) => z.string().trim().min(1).max(max);

export const tenantBrandingSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/),
    displayName: text(120),
    shortName: text(40),
    logoPath: z.string().regex(LOGIN_LOGO_PATH_PATTERN).nullable(),
    headline: text(120).nullable(),
    tagline: text(160),
    badgeLabel: text(24).nullable(),
    supportText: text(160),
  })
  .strip();

const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

export type BrandingResult = { status: "ok"; branding: TenantLoginBranding } | { status: "not_found" } | { status: "unavailable" };

/** Where the Next.js server reaches the PulseOS API (not the browser's address; the same default as the api-client). */
const apiBase = () => process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4310";

/** Resolves the sign-in branding for a slug. Never throws: an unknown or malformed name is `not_found`, an unreachable API is `unavailable`. */
export async function fetchTenantBranding(slug: string): Promise<BrandingResult> {
  if (!SLUG.test(slug)) return { status: "not_found" };
  try {
    const res = await fetch(`${apiBase()}/auth/tenants/${encodeURIComponent(slug)}`, { cache: "no-store", headers: { accept: "application/json" } });
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "unavailable" };
    const parsed = tenantBrandingSchema.safeParse(await res.json());
    return parsed.success && parsed.data.slug === slug ? { status: "ok", branding: parsed.data } : { status: "not_found" };
  } catch {
    return { status: "unavailable" };
  }
}

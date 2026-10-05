import { eq } from "drizzle-orm";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import type { Db } from "../../db/client.js";
import { tenants } from "../../db/schema.js";

export interface NormalizedPhone {
  raw: string;
  e164: string | null;
  country: string | null;
  valid: boolean;
}

// Canonical phone identity: raw input is always preserved (patients.phone,
// the display value), E.164 is the only value ever used for identity
// matching (patients.phoneE164), and a tenant's default region is a
// parameter, not a hard-coded assumption — see resolveDefaultPhoneRegion
// below, and identity.service.ts::resolveOrCreatePatient, the single
// identity-resolution path every entry point (manual Add Lead/Patient,
// website, Meta, Google, WhatsApp, Runo) shares.
export function normalizePhone(raw: string, defaultRegion: string): NormalizedPhone {
  const trimmed = raw.trim();
  try {
    const parsed = parsePhoneNumberFromString(trimmed, defaultRegion as CountryCode);
    if (parsed && parsed.isValid()) {
      return { raw: trimmed, e164: parsed.number, country: parsed.country ?? null, valid: true };
    }
  } catch {
    // libphonenumber-js throws on some malformed input rather than returning
    // undefined — treated identically to "could not parse".
  }
  return { raw: trimmed, e164: null, country: null, valid: false };
}

// Shared by every entry point that needs to normalize a phone without
// already knowing the tenant's region (manual Add Lead/Add Patient,
// website/Meta/Google ingestion, WhatsApp/Runo webhook identity resolution).
export async function resolveDefaultPhoneRegion(db: Db, tenantId: string): Promise<string> {
  const [tenant] = await db.select({ defaultPhoneRegion: tenants.defaultPhoneRegion }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return tenant?.defaultPhoneRegion ?? "IN";
}

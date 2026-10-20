import { z } from "zod";
import type { DbOrTx } from "../../db/client.js";
import { platformSettings } from "../../db/schema.js";

/**
 * The genuinely global settings - each one is read by real behaviour:
 *  defaultEdition / defaultTimezone / defaultLocale  -> the Create Tenant wizard's starting values (and the API's defaults)
 *  invitationExpiryHours                             -> every invitation and password-reset link's lifetime
 *  supportSessionDefaultMinutes / ...MaxMinutes      -> Support Mode session length
 *  supportEditsMaxMinutes                            -> how long support edits stay enabled
 *  supportContact                                    -> shown to hospital staff whose workspace is unavailable, and in emails
 */
export const platformSettingsSchema = z
  .object({
    defaultEdition: z.enum(["BETA_V1_CORE", "BETA_V2_GROWTH"]),
    defaultTimezone: z.string().min(3).max(64).refine(isTimeZone, "Unknown time zone"),
    defaultLocale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Use a locale like en-IN"),
    invitationExpiryHours: z.number().int().min(1).max(24 * 14),
    supportSessionDefaultMinutes: z.number().int().min(5).max(240),
    supportSessionMaxMinutes: z.number().int().min(5).max(480),
    supportEditsMaxMinutes: z.number().int().min(5).max(120),
    supportContact: z.string().trim().max(160),
  })
  .refine((s) => s.supportSessionDefaultMinutes <= s.supportSessionMaxMinutes, { message: "The default support session cannot be longer than the maximum", path: ["supportSessionDefaultMinutes"] });

export type PlatformSettingsValues = z.infer<typeof platformSettingsSchema>;

export const PLATFORM_SETTING_DEFAULTS: PlatformSettingsValues = {
  defaultEdition: "BETA_V1_CORE",
  defaultTimezone: "Asia/Kolkata",
  defaultLocale: "en-IN",
  invitationExpiryHours: 72,
  supportSessionDefaultMinutes: 30,
  supportSessionMaxMinutes: 120,
  supportEditsMaxMinutes: 30,
  supportContact: "",
};

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Stored values over defaults. A stored value that no longer validates falls back to its default rather than breaking anything. */
export async function getPlatformSettings(db: DbOrTx): Promise<PlatformSettingsValues> {
  const rows = await db.select().from(platformSettings);
  const merged: Record<string, unknown> = { ...PLATFORM_SETTING_DEFAULTS };
  for (const r of rows) if (r.key in PLATFORM_SETTING_DEFAULTS) merged[r.key] = r.value;
  const parsed = platformSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : PLATFORM_SETTING_DEFAULTS;
}

export async function savePlatformSettings(db: DbOrTx, values: PlatformSettingsValues, actorId: string): Promise<string[]> {
  const current = await getPlatformSettings(db);
  const changed = (Object.keys(values) as (keyof PlatformSettingsValues)[]).filter((k) => values[k] !== current[k]);
  for (const key of changed) {
    await db
      .insert(platformSettings)
      .values({ key, value: values[key], updatedBy: actorId })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: values[key], updatedBy: actorId, updatedAt: new Date() } });
  }
  return changed;
}

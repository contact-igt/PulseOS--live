/** Whole years between a date of birth and a day (both YYYY-MM-DD). Null when the date of birth is missing or after the day. */
export function ageFromDateOfBirth(dateOfBirth: string | null, todayKey: string): number | null {
  if (!dateOfBirth) return null;
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = todayKey.split("-").map(Number);
  if ([by, bm, bd, ty, tm, td].some((n) => !Number.isInteger(n))) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 ? age : null;
}

/** The age to show: exact from a date of birth when known, otherwise what the patient reported. */
export function displayAge(dateOfBirth: string | null, reportedAge: number | null, todayKey: string): number | null {
  return ageFromDateOfBirth(dateOfBirth, todayKey) ?? reportedAge;
}

export const MAX_AGE_YEARS = 120;

/** A calendar date in YYYY-MM-DD that exists and is not after `todayKey`. */
export function isValidPastDate(value: string, todayKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return value <= todayKey && y >= 1900;
}

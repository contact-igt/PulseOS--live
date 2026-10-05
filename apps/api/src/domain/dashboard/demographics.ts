// Who is enquiring: age group and the hospital's own filterable fields (area, gender, patient type ...) over the SAME cohort as the
// Performance funnel. Pure counting, no stored "age group": the group is derived from the date of birth (or the reported age) at
// report time, so the raw patient data stays the only truth. A dimension appears only when there is real data behind it.

import type { DemographicDimension, DemographicRow } from "@pulseos/types";

export const AGE_GROUPS = [
  { key: "0-17", label: "Under 18", min: 0, max: 17 },
  { key: "18-34", label: "18–34", min: 18, max: 34 },
  { key: "35-49", label: "35–49", min: 35, max: 49 },
  { key: "50-64", label: "50–64", min: 50, max: 64 },
  { key: "65+", label: "65 and over", min: 65, max: 200 },
] as const;

export function ageGroupOf(age: number | null): (typeof AGE_GROUPS)[number] | null {
  if (age === null || !Number.isFinite(age) || age < 0) return null;
  return AGE_GROUPS.find((g) => age >= g.min && age <= g.max) ?? null;
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

function rowsOf(counts: Map<string, number>, total: number, order?: string[]): DemographicRow[] {
  const entries = [...counts.entries()];
  entries.sort((a, b) => (order ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0])));
  return entries.map(([label, count]) => ({ label, count, pct: pct(count, total) }));
}

/** Age groups from ages (null = not recorded; those are left out of the chart, never counted as a group). Null when nobody has an age. */
export function buildAgeDimension(ages: (number | null)[]): DemographicDimension | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const age of ages) {
    const g = ageGroupOf(age);
    if (!g) continue;
    total++;
    counts.set(g.label, (counts.get(g.label) ?? 0) + 1);
  }
  if (total === 0) return null;
  return { key: "age_group", label: "Age group", answered: total, rows: rowsOf(counts, total, AGE_GROUPS.map((g) => g.label)) };
}

const MAX_ROWS = 8;

/**
 * One dimension per configured field from its answers. A free-text field only qualifies when some answers REPEAT (an area or locality does;
 * a UID or a reference number, different for every person, does not and is left out). Choice fields always qualify. Null with no answers.
 */
export function buildFieldDimension(field: { key: string; label: string; fieldType: string }, answers: string[]): DemographicDimension | null {
  const clean = answers.map((a) => a.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  const counts = new Map<string, number>();
  for (const a of clean) counts.set(a, (counts.get(a) ?? 0) + 1);
  if (field.fieldType === "TEXT" && clean.length >= 3 && counts.size === clean.length) return null; // every answer different: an identifier, not a group
  const rows = rowsOf(counts, clean.length);
  const shown = rows.slice(0, MAX_ROWS);
  const rest = rows.slice(MAX_ROWS).reduce((n, r) => n + r.count, 0);
  if (rest > 0) shown.push({ label: "Other", count: rest, pct: pct(rest, clean.length) });
  return { key: field.key, label: field.label, answered: clean.length, rows: shown };
}

import type { ClinicHours, ClinicHoursDay } from "@pulseos/types";

export const WEEKDAYS = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number]["key"];

export interface HoursRow {
  open: boolean;
  from: string;
  to: string;
}
export type HoursForm = Record<WeekdayKey, HoursRow>;

const DEFAULT_DAY: [string, string] = ["09:00", "17:00"];

/** The editable form for the hospital's hours. A hospital with no hours set starts from a sensible Mon–Sat week. */
export function hoursToForm(hours: ClinicHours | null | undefined): HoursForm {
  const form = {} as HoursForm;
  for (const { key } of WEEKDAYS) {
    const d: ClinicHoursDay | undefined = hours ? hours[key] : key === "sun" ? null : DEFAULT_DAY;
    form[key] = d ? { open: true, from: d[0], to: d[1] } : { open: false, from: DEFAULT_DAY[0], to: DEFAULT_DAY[1] };
  }
  return form;
}

/** The request body, or the first thing wrong in plain words. At least one day must be open: an all-closed week books nobody. */
export function formToHours(form: HoursForm): { hours: ClinicHours } | { error: string } {
  const out = {} as ClinicHours;
  let anyOpen = false;
  for (const { key, label } of WEEKDAYS) {
    const row = form[key];
    if (!row.open) {
      out[key] = null;
      continue;
    }
    if (!/^\d{2}:\d{2}$/.test(row.from) || !/^\d{2}:\d{2}$/.test(row.to)) return { error: `${label}: choose the opening and closing time.` };
    if (row.from >= row.to) return { error: `${label}: closing time must be after opening time.` };
    out[key] = [row.from, row.to];
    anyOpen = true;
  }
  return anyOpen ? { hours: out } : { error: "Keep at least one day open." };
}

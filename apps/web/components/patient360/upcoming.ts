import { localDayKey } from "@pulseos/ui";
import type { PatientUpcomingItem } from "@pulseos/types";

export interface UpcomingGroup {
  /** "overdue" or a hospital-local day key (yyyy-mm-dd). */
  key: string;
  items: PatientUpcomingItem[];
}

/**
 * Overdue tasks first, then one group per hospital-local day, each in time
 * order. `journeyId` narrows to one journey (the Patient 360 journey selector).
 */
export function groupUpcoming(items: PatientUpcomingItem[], timeZone: string, journeyId?: string): UpcomingGroup[] {
  const scoped = (journeyId ? items.filter((i) => i.journeyId === journeyId) : items).slice().sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const groups: UpcomingGroup[] = [];
  const overdue = scoped.filter((i) => i.overdue);
  if (overdue.length) groups.push({ key: "overdue", items: overdue });
  for (const i of scoped) {
    if (i.overdue) continue;
    const key = localDayKey(i.at, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(i);
    else groups.push({ key, items: [i] });
  }
  return groups;
}

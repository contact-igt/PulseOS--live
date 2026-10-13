export interface DayGroup<T> {
  /** The hospital's calendar day, YYYY-MM-DD. */
  key: string;
  /** "Today", "Yesterday", or the date. */
  label: string;
  items: T[];
}

const dayKey = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** The day before a YYYY-MM-DD key, by calendar arithmetic (no clock, no timezone). */
const previousDay = (key: string) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

/**
 * Split a thread into days, by the HOSPITAL's calendar (never the viewer's browser zone), so the separators say the same thing
 * to everyone. Items stay in the order given (oldest first).
 */
export function groupMessagesByDay<T extends { sentAt: string }>(items: readonly T[], timeZone: string, now: Date = new Date()): DayGroup<T>[] {
  const today = dayKey(now, timeZone);
  const yesterday = previousDay(today);
  const dateLabel = new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric" });
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const at = new Date(item.sentAt);
    const key = dayKey(at, timeZone);
    const last = groups.at(-1);
    if (last && last.key === key) {
      last.items.push(item);
    } else {
      groups.push({ key, label: key === today ? "Today" : key === yesterday ? "Yesterday" : dateLabel.format(at), items: [item] });
    }
  }
  return groups;
}

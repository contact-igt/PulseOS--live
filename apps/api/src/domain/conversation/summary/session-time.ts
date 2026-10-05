import { CONVERSATION_IDLE_RANGE } from "@pulseos/types";

/** The idle window is configurable but kept inside a safe range (5–10 minutes). */
export function clampIdleMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CONVERSATION_IDLE_RANGE.default;
  return Math.min(CONVERSATION_IDLE_RANGE.max, Math.max(CONVERSATION_IDLE_RANGE.min, Math.round(value)));
}

/** When a conversation that last saw a message at `lastMessageAt` is idle enough to summarize. */
export const dueAfter = (lastMessageAt: Date, idleMinutes: number): Date => new Date(lastMessageAt.getTime() + idleMinutes * 60_000);

function clock(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s?(am|pm)$/i, (_, m: string) => ` ${m.toLowerCase()}`);
}

/** The one concise Timeline line for a conversation session: count and time range in the hospital timezone. */
export function sessionTitle(count: number, first: Date, last: Date, timeZone: string): string {
  const a = clock(first, timeZone);
  const b = clock(last, timeZone);
  return `WhatsApp conversation · ${count} message${count === 1 ? "" : "s"} · ${a === b ? a : `${a} – ${b}`}`;
}

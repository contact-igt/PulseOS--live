import type { NotificationOffsetUnit, NotificationRuleKind, NotificationSuppression } from "@pulseos/types";

export interface PlanRule {
  id: string;
  kind: NotificationRuleKind;
  enabled: boolean;
  offsetValue: number;
  offsetUnit: NotificationOffsetUnit;
  minGapMinutes: number;
}

export interface PlannedNotification {
  ruleId: string;
  triggerAt: Date;
}
export interface SuppressedNotification {
  ruleId: string;
  reason: NotificationSuppression;
}
export interface Plan {
  planned: PlannedNotification[];
  suppressed: SuppressedNotification[];
}

const UNIT_MS: Record<NotificationOffsetUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
export const offsetMs = (r: Pick<PlanRule, "offsetValue" | "offsetUnit">) => r.offsetValue * UNIT_MS[r.offsetUnit];

/**
 * Decide which notifications a visit/surgery should get. Pure: no clock, no database.
 *  - a disabled rule produces nothing (RULE_DISABLED);
 *  - a cancelled subject produces nothing (APPOINTMENT_CANCELLED);
 *  - a CONFIRMATION goes out now; a REMINDER goes out `offset` before the start, and if that moment has already passed it is
 *    never sent late (TRIGGER_ALREADY_PASSED);
 *  - notifications are considered in time order and one that would land closer than its rule's minimum gap to the one
 *    before it is dropped (TOO_CLOSE_TO_PREVIOUS_NOTIFICATION) — so a visit booked an hour ahead does not get a
 *    confirmation and a reminder in the same minute.
 * `alreadyScheduled` are the trigger times of notifications that already exist for this subject (kept ones count for the gap).
 */
export function planNotifications(input: { start: Date; now: Date; rules: PlanRule[]; cancelled?: boolean; alreadyScheduled?: Date[] }): Plan {
  const { start, now } = input;
  const plan: Plan = { planned: [], suppressed: [] };
  const candidates: { rule: PlanRule; at: Date }[] = [];

  for (const rule of input.rules) {
    if (!rule.enabled) {
      plan.suppressed.push({ ruleId: rule.id, reason: "RULE_DISABLED" });
      continue;
    }
    if (input.cancelled) {
      plan.suppressed.push({ ruleId: rule.id, reason: "APPOINTMENT_CANCELLED" });
      continue;
    }
    const at = rule.kind === "CONFIRMATION" ? now : new Date(start.getTime() - offsetMs(rule));
    if (rule.kind === "REMINDER" && at.getTime() <= now.getTime()) {
      plan.suppressed.push({ ruleId: rule.id, reason: "TRIGGER_ALREADY_PASSED" });
      continue;
    }
    candidates.push({ rule, at });
  }

  candidates.sort((a, b) => a.at.getTime() - b.at.getTime());
  const kept: Date[] = [...(input.alreadyScheduled ?? [])];
  for (const c of candidates) {
    const gapMs = c.rule.minGapMinutes * 60_000;
    const tooClose = kept.some((k) => Math.abs(c.at.getTime() - k.getTime()) < gapMs);
    if (tooClose) {
      plan.suppressed.push({ ruleId: c.rule.id, reason: "TOO_CLOSE_TO_PREVIOUS_NOTIFICATION" });
      continue;
    }
    kept.push(c.at);
    plan.planned.push({ ruleId: c.rule.id, triggerAt: c.at });
  }
  return plan;
}

/** Default rules: appointment confirmation now / 1 day / 1 hour; surgery 1 day / 2 hours / 1 hour. */
export const DEFAULT_RULES: { subject: "APPOINTMENT" | "SURGERY"; kind: NotificationRuleKind; offsetValue: number; offsetUnit: NotificationOffsetUnit }[] = [
  { subject: "APPOINTMENT", kind: "CONFIRMATION", offsetValue: 0, offsetUnit: "minutes" },
  { subject: "APPOINTMENT", kind: "REMINDER", offsetValue: 1, offsetUnit: "days" },
  { subject: "APPOINTMENT", kind: "REMINDER", offsetValue: 1, offsetUnit: "hours" },
  { subject: "SURGERY", kind: "REMINDER", offsetValue: 1, offsetUnit: "days" },
  { subject: "SURGERY", kind: "REMINDER", offsetValue: 2, offsetUnit: "hours" },
  { subject: "SURGERY", kind: "REMINDER", offsetValue: 1, offsetUnit: "hours" },
];

/** The idempotency key: one notification per rule per concrete visit time. A reschedule changes the time, so it never collides. */
export function notificationKey(ruleId: string, subjectId: string, start: Date): string {
  return `${ruleId}:${subjectId}:${start.getTime()}`;
}

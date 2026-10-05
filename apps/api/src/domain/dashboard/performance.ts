import { PERFORMANCE_FUNNEL_STEPS, type PerformanceAlert, type PerformanceBreakdownRow, type PerformanceFunnelStep, type PerformanceInsight } from "@pulseos/types";

// Pure counting for the owner's Performance view. A journey is placed at the FURTHEST step it really reached, and a step's count
// is "reached at least this step" - so the funnel never grows to the right, and a walk-in who was never phoned still counts as
// having reached the clinic. Insights and the alert are plain rules (a count, a threshold), never a model or a forecast.

export interface PerfJourneyFact {
  id: string;
  sourceKey: string | null;
  sourceLabel: string;
  journeyType: string;
  ownerId: string | null;
  /** Staff spoke to the patient (the journey has a contact time). */
  contacted: boolean;
  /** At least one appointment was booked. */
  booked: boolean;
  /** At least one visit where the patient arrived (checked in, waiting, with the doctor or completed). */
  attended: boolean;
  /** At least one consultation completed. */
  consulted: boolean;
  /** At least one visit marked no-show. */
  noShow: boolean;
  /** A procedure was advised (any treatment record). */
  advised: boolean;
  /** A procedure is scheduled or already done (the journey reached scheduling). */
  scheduled: boolean;
  /** A procedure was completed. Scheduled alone never sets this. */
  done: boolean;
  lost: boolean;
}

/** 0 = enquiry only ... 6 = procedure done: the highest step any of the journey's facts reaches (a phone contact is not a step). */
export function furthestStep(f: PerfJourneyFact): number {
  if (f.done) return 6;
  if (f.scheduled) return 5;
  if (f.advised) return 4;
  if (f.consulted) return 3;
  if (f.attended) return 2;
  if (f.booked) return 1;
  return 0;
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

export function buildFunnel(facts: PerfJourneyFact[]): PerformanceFunnelStep[] {
  const reached = PERFORMANCE_FUNNEL_STEPS.map((_, step) => facts.filter((f) => furthestStep(f) >= step).length);
  return PERFORMANCE_FUNNEL_STEPS.map((s, i) => ({
    key: s.key,
    label: s.label,
    count: reached[i]!,
    conversionFromPrevious: i === 0 ? null : pct(reached[i]!, reached[i - 1]!),
    droppedBefore: i === 0 ? 0 : reached[i - 1]! - reached[i]!,
  }));
}

/** The same step counts per group (a source, a service...), biggest first, name as the tie-break. */
export function buildBreakdown(facts: PerfJourneyFact[], group: (f: PerfJourneyFact) => { key: string; label: string }): PerformanceBreakdownRow[] {
  const rows = new Map<string, PerformanceBreakdownRow>();
  for (const f of facts) {
    const g = group(f);
    const row = rows.get(g.key) ?? { key: g.key, label: g.label, enquiries: 0, booked: 0, attended: 0, consulted: 0, advised: 0, scheduled: 0, done: 0 };
    const step = furthestStep(f);
    row.enquiries++;
    if (step >= 1) row.booked++;
    if (step >= 2) row.attended++;
    if (step >= 3) row.consulted++;
    if (step >= 4) row.advised++;
    if (step >= 5) row.scheduled++;
    if (step >= 6) row.done++;
    rows.set(g.key, row);
  }
  return [...rows.values()].sort((a, b) => b.enquiries - a.enquiries || a.label.localeCompare(b.label));
}

export interface InsightCounts {
  /** Enquiries (in the period) nobody has contacted. */
  uncontacted: number;
  /** Open follow-ups past due right now. */
  overdueFollowUps: number;
  /** Booked patients who did not come (in the period). */
  noShows: number;
  /** Completed consultations with no outcome recorded. */
  noOutcome: number;
  /** Advised procedures still undecided after 7 days. */
  undecided: number;
  /** Enquiries closed as lost (in the period). */
  lost: number;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Findings worth acting on, in a fixed order, each with the existing view that fixes it. Nothing is said when the count is 0. */
export function buildInsights(c: InsightCounts): PerformanceInsight[] {
  const out: PerformanceInsight[] = [];
  const add = (i: PerformanceInsight) => c[KEY_COUNT[i.key]] > 0 && out.push(i);
  add({ key: "uncontacted", count: c.uncontacted, severity: "attention", href: "/leads?view=uncontacted", message: `${c.uncontacted} ${plural(c.uncontacted, "enquiry has", "enquiries have")} not yet been contacted` });
  add({ key: "overdue_followups", count: c.overdueFollowUps, severity: "attention", href: "/leads?view=follow_up_due&due=overdue", message: `${c.overdueFollowUps} ${plural(c.overdueFollowUps, "follow-up is", "follow-ups are")} overdue` });
  add({ key: "no_shows", count: c.noShows, severity: "attention", href: "/appointments?status=no_show", message: `${c.noShows} booked ${plural(c.noShows, "patient", "patients")} did not come` });
  add({ key: "no_outcome", count: c.noOutcome, severity: "attention", href: "/appointments?status=completed", message: `${c.noOutcome} completed ${plural(c.noOutcome, "consultation has", "consultations have")} no outcome recorded` });
  add({ key: "undecided", count: c.undecided, severity: "info", href: "/treatments?status=DECISION_PENDING", message: `${c.undecided} advised ${plural(c.undecided, "procedure is", "procedures are")} still undecided after 7 days` });
  add({ key: "lost", count: c.lost, severity: "info", href: "/leads?view=lost", message: `${c.lost} ${plural(c.lost, "enquiry was", "enquiries were")} closed as lost` });
  return out;
}

const KEY_COUNT = { uncontacted: "uncontacted", overdue_followups: "overdueFollowUps", no_shows: "noShows", no_outcome: "noOutcome", undecided: "undecided", lost: "lost" } as const satisfies Record<PerformanceInsight["key"], keyof InsightCounts>;

export interface AlertSnapshot {
  enquiries: number;
  contacted: number;
  booked: number;
  noShows: number;
}

// Thresholds are deliberately plain and fixed: a quarter fewer enquiries, under 60% reached, a quarter of bookings missed - and only
// once there are enough cases (8) for a percentage to mean anything.
const MIN_CASES = 8;
const ENQUIRIES_DOWN = 25;
const CONTACT_RATE_LOW = 60;
const NO_SHOW_RATE_HIGH = 25;

/** The single most serious rule that applies, or null. `days` is the length of both periods (the previous one is the same length, just before). */
export function buildAlert(current: AlertSnapshot, previous: AlertSnapshot, days: number): PerformanceAlert | null {
  if (previous.enquiries >= MIN_CASES && current.enquiries < previous.enquiries) {
    const down = Math.round(((previous.enquiries - current.enquiries) / previous.enquiries) * 100);
    if (down >= ENQUIRIES_DOWN) {
      return { kind: "enquiries_down", label: "Rule-based alert", message: `Enquiries are down ${down}% on the previous ${days} days`, detail: `${current.enquiries} now, ${previous.enquiries} before` };
    }
  }
  if (current.enquiries >= MIN_CASES) {
    const reached = Math.round((current.contacted / current.enquiries) * 100);
    if (reached < CONTACT_RATE_LOW) {
      return { kind: "contact_rate_low", label: "Rule-based alert", message: `Only ${reached}% of this period's enquiries have been contacted`, detail: `${current.contacted} of ${current.enquiries} contacted` };
    }
  }
  if (current.booked >= MIN_CASES) {
    const missed = Math.round((current.noShows / current.booked) * 100);
    if (missed >= NO_SHOW_RATE_HIGH) {
      return { kind: "no_show_rate_high", label: "Rule-based alert", message: `${missed}% of booked patients did not come`, detail: `${current.noShows} of ${current.booked} booked` };
    }
  }
  return null;
}

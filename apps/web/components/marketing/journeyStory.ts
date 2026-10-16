import { HOOK_STAGES } from "./content";

// The interactive patient journey. One synthetic patient (Priya) moves through five chapters; each chapter adds timeline
// events and moves the hospital's funnel numbers. Pure data + one function so the story can be tested without rendering.

export type StoryEvent = { id: string; day: "Today" | "Tuesday"; time: string; title: string; detail: string; kind: "lead" | "call" | "appt" | "visit" | "consult" | "proc" | "task" };

export type StoryStep = {
  key: string;
  short: string;
  title: string;
  body: string;
  /** What the person does in PulseOS to move the patient on. Doubles as the button label. */
  action: string;
  status: { label: string; tone: "primary" | "warning" | "success" | "neutral" };
  nextAction: string;
  events: StoryEvent[];
  /** Funnel rows (indexes into HOOK_STAGES) Priya has reached by the end of this step. */
  reached: number;
};

const E = (id: string, day: StoryEvent["day"], time: string, title: string, detail: string, kind: StoryEvent["kind"]): StoryEvent => ({ id, day, time, title, detail, kind });

export const STORY_STEPS: StoryStep[] = [
  {
    key: "enquiry",
    short: "Enquiry",
    title: "The enquiry arrives",
    body: "Google, Cataract. It lands on a journey with a source and an assigned team member, not in a spreadsheet.",
    action: "Log the call",
    status: { label: "New enquiry", tone: "primary" },
    nextAction: "Call Priya today",
    reached: 0,
    events: [E("lead", "Today", "10:12 AM", "Lead created", "Google · Cataract · Assigned to Shivani", "lead")],
  },
  {
    key: "call",
    short: "Call",
    title: "The coordinator calls",
    body: "The call is logged on the journey. The outcome sets the next action.",
    action: "Confirm appointment",
    status: { label: "Call connected", tone: "primary" },
    nextAction: "Book appointment",
    reached: 0,
    events: [E("call", "Today", "10:20 AM", "Call connected", "Patient asks about surgery · Next action: book appointment", "call")],
  },
  {
    key: "appointment",
    short: "Appointment",
    title: "Appointment confirmed",
    body: "Booked while still on the call. Confirmation and reminder are planned and go out when your messaging provider is connected.",
    action: "Check in",
    status: { label: "Confirmed", tone: "success" },
    nextAction: "Patient visit · Tue 10:30 AM",
    reached: 1,
    events: [E("appt", "Today", "10:24 AM", "Appointment confirmed", "Tue · 10:30 AM · Confirmation and reminder planned*", "appt")],
  },
  {
    key: "arrival",
    short: "Arrival",
    title: "The patient arrives",
    body: "Check in puts Priya in the waiting queue. Front desk and doctor see the same status.",
    action: "Send to doctor",
    status: { label: "Waiting · 8 min", tone: "warning" },
    nextAction: "Send to doctor",
    reached: 2,
    events: [E("checkin", "Tuesday", "10:22 AM", "Checked in", "Waiting · 8 min", "visit")],
  },
  {
    key: "consultation",
    short: "Consultation",
    title: "Consultation completed",
    body: "The doctor advises a procedure. The outcome lands on the journey and the source is still attached.",
    action: "Replay the journey",
    status: { label: "Procedure advised", tone: "primary" },
    nextAction: "Coordinator follow-up · tomorrow 11:00 AM",
    reached: 4,
    events: [
      E("doctor", "Tuesday", "10:38 AM", "Sent to doctor", "With doctor · Dr. Menon", "visit"),
      E("consult", "Tuesday", "11:02 AM", "Consultation completed", "Cataract assessment done", "consult"),
      E("advised", "Tuesday", "11:05 AM", "Procedure advised", "Cataract surgery · decision pending", "proc"),
      E("task", "Tuesday", "11:06 AM", "Follow-up scheduled", "Coordinator follow-up · tomorrow 11:00 AM", "task"),
    ],
  },
];

/** Events visible at a step: everything up to and including it. */
export function eventsAt(step: number): StoryEvent[] {
  return STORY_STEPS.slice(0, step + 1).flatMap((s) => s.events);
}

/**
 * Funnel counts at a step: the hospital's existing counts plus Priya wherever she has reached.
 * step 0 adds an enquiry; step 2 adds a booked appointment; step 3 a visit; step 4 a consultation and an advised procedure.
 */
export function funnelAt(step: number): number[] {
  const base: number[] = HOOK_STAGES.map((s) => s.count);
  const reached = STORY_STEPS[step]?.reached ?? 0;
  return base.map((n, i) => n + (i <= reached ? 1 : 0));
}

/** Which funnel rows increased at exactly this step (for the "+1" highlight). */
export function changedAt(step: number): number[] {
  if (step === 0) return [0];
  const prev = funnelAt(step - 1);
  const cur = funnelAt(step);
  return cur.flatMap((n, i) => (n !== prev[i] ? [i] : []));
}

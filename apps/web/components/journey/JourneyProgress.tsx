import { Check, TriangleAlert } from "lucide-react";
import type { JourneyDetailVm } from "@pulseos/types";
import { buildJourneyProgress, type ProgressState } from "./progressSteps";

const DOT: Record<ProgressState, string> = {
  done: "bg-primary-600 text-white",
  current: "border-2 border-primary-600 bg-white text-primary-600",
  pending: "border border-line-strong bg-white text-neutral-300",
  problem: "bg-danger-100 text-danger-700 ring-1 ring-inset ring-danger-200",
};

/**
 * Journey Progress: Enquiry -> Appointment -> Attendance -> Consultation -> Treatment -> Next action, each with the real
 * fact behind it (the original source, the visit and its state, the check-in time, what was advised). Built from the
 * journey's rows, not from its stage name, so it never claims a step that did not happen.
 */
export function JourneyProgress({ detail }: { detail: Pick<JourneyDetailVm, "appointments" | "treatments" | "journey"> }) {
  const steps = buildJourneyProgress(detail);
  return (
    <ol className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Journey progress" data-testid="journey-progress">
      {steps.map((s) => (
        <li key={s.key} className="flex min-w-0 items-start gap-2" data-testid={`journey-progress-${s.key}`} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
          <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${DOT[s.state]}`} aria-hidden="true">
            {s.state === "done" ? <Check size={12} strokeWidth={3} /> : s.state === "problem" ? <TriangleAlert size={11} /> : null}
          </span>
          <span className="min-w-0">
            <span className={`block text-[11px] font-semibold uppercase tracking-wide ${s.state === "pending" ? "text-neutral-500" : "text-ink-2"}`}>{s.label}</span>
            <span className={`block text-xs leading-4 ${s.tone === "danger" ? "font-medium text-danger-700" : s.state === "pending" ? "text-neutral-500" : "text-ink"}`}>{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

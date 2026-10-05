import type { JourneyStage } from "@pulseos/types";

// Four checkpoints a coordinator actually thinks in, collapsed from the
// finer-grained JourneyStage enum. Same collapse as the Patient 360 journey
// card (kept as a local copy: that page is a route file and cannot be imported).
const STEPS = ["Enquiry", "Appointment", "Consultation", "Treatment"] as const;
// "completed" points one past the last step so Treatment renders as done.
const STAGE_CHECKPOINT: Partial<Record<JourneyStage, number>> = {
  enquiry: 0, contacted: 0, booked: 1, attended: 1, consulted: 2, treatment_advised: 2, scheduled: 3, completed: 4,
};

export function JourneyStageFlow({ stage }: { stage: JourneyStage }) {
  if (stage === "lost") return null;
  const current = STAGE_CHECKPOINT[stage] ?? 0;
  const currentLabel = STEPS[current] ?? "Treatment complete";
  return (
    <ol className="flex items-center" aria-label={`Progress: ${currentLabel}`} data-testid="journey-stage-flow">
      {STEPS.map((label, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none" aria-current={isCurrent ? "step" : undefined}>
            <div className="flex items-center gap-1.5">
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${
                  done ? "bg-primary-600 text-white" : isCurrent ? "border-2 border-primary-600 bg-white text-primary-600" : "border border-line-strong bg-white text-neutral-300"
                }`}
                aria-hidden="true"
              >
                {done ? "✓" : ""}
              </span>
              {/* Below sm only the current step keeps its label, so four steps always fit a phone card. */}
              <span className={`whitespace-nowrap text-[11px] ${isCurrent ? "font-semibold text-ink" : `hidden sm:inline ${done ? "text-ink-2" : "text-neutral-400"}`}`}>{label}</span>
            </div>
            {i < STEPS.length - 1 && <span className={`mx-2 h-px min-w-3 flex-1 ${done ? "bg-primary-600" : "bg-line"}`} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

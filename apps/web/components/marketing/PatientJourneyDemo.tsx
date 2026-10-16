"use client";

import { useState } from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import { Card } from "@pulseos/ui/src/primitives";
import { CONTAINER, Eyebrow, Pill, UiCard as UiCardLike } from "./ui";
import { HOOK_STAGES } from "./content";
import { STORY_STEPS, changedAt, eventsAt, funnelAt } from "./journeyStory";
import { TimelineList } from "./ProductPanels";
import { useTabKeys } from "./useTabKeys";

/**
 * Follow one patient. The visitor does what a coordinator or front desk would do in PulseOS (log the call, confirm, check in,
 * send to doctor) and watches the patient's timeline and the hospital's funnel respond. Five chapters instead of ten clicks.
 */
export function PatientJourneyDemo() {
  const [step, setStep] = useState(0);
  const { onKeyDown, setRef } = useTabKeys(STORY_STEPS.length, step, setStep, "vertical");
  const current = STORY_STEPS[step]!;
  const last = step === STORY_STEPS.length - 1;
  const counts = funnelAt(step);
  const changed = changedAt(step);
  const events = eventsAt(step);
  const newest = current.events[current.events.length - 1]?.id;

  return (
    <section id="journey" aria-labelledby="journey-title" className="mk-anchor bg-white py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[760px]">
          <Eyebrow>The journey</Eyebrow>
          <h2 id="journey-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            Follow one patient. See the whole journey.
          </h2>
          <p className="mt-5 max-w-[650px] text-[18px] leading-relaxed text-ink-2">Do what your team would do. Watch the timeline and the owner&apos;s numbers respond. Synthetic patient.</p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-8 lg:grid-cols-[340px_1fr] lg:gap-10">
          {/* Chapters: a vertical list on desktop, a scrolling row of pills on small screens. */}
          <div className="min-w-0">
            <div role="tablist" aria-label="Journey chapters" aria-orientation="vertical" onKeyDown={onKeyDown} className="mk-scroll-x -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0" data-testid="journey-steps">
              {STORY_STEPS.map((s, i) => (
                <button
                  key={s.key}
                  ref={setRef(i)}
                  role="tab"
                  id={`pj-tab-${i}`}
                  aria-selected={step === i}
                  aria-controls="pj-panel"
                  tabIndex={step === i ? 0 : -1}
                  type="button"
                  onClick={() => setStep(i)}
                  className={`flex min-h-11 shrink-0 items-center gap-3 rounded-card border px-3.5 py-2.5 text-left transition lg:items-start lg:py-3 ${step === i ? "border-primary-300 bg-primary-50" : "border-transparent hover:bg-surface-muted"}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${i <= step ? "bg-brand text-white" : "border border-primary-300 bg-white text-primary-700"}`}>{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block whitespace-nowrap text-[15px] font-semibold text-ink lg:whitespace-normal">
                      <span className="lg:hidden">{s.short}</span>
                      <span className="hidden lg:inline">{s.title}</span>
                    </span>
                    {step === i && <span className="mt-1 hidden text-[14px] leading-snug text-ink-2 lg:block">{s.body}</span>}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-4 text-[15px] leading-snug text-ink-2 lg:hidden" data-testid="journey-step-body">
              <span className="font-semibold text-ink">{current.title}.</span> {current.body}
            </p>
          </div>

          <div id="pj-panel" role="tabpanel" aria-labelledby={`pj-tab-${step}`} tabIndex={0} className="min-w-0 rounded-panel border border-line bg-canvas-base p-3 sm:p-5" style={{ backgroundColor: "var(--color-canvas-base)" }} data-testid="journey-panel">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1.25fr_1fr]">
              <div className="space-y-3">
                <Card>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-100 text-sm font-semibold text-primary-800" aria-hidden="true">PR</span>
                      <div>
                        <p className="text-[15px] font-semibold tracking-wide text-ink">PRIYA</p>
                        <p className="text-xs text-ink-2">Cataract enquiry · Source: Google · Today 10:12 AM</p>
                      </div>
                    </div>
                    <span key={current.key} className="mk-swap"><Pill tone={current.status.tone}>{current.status.label}</Pill></span>
                  </div>
                  <div className="border-t border-line bg-surface-info px-4 py-2.5 text-[13px] text-ink-2" data-testid="journey-next-action">
                    Next action: <span className="font-medium text-ink">{current.nextAction}</span>
                  </div>
                </Card>
                <UiCardLike title="Timeline" meta={`${events.length} event${events.length === 1 ? "" : "s"}`}>
                  <div className="px-4 py-4" aria-live="polite" data-testid="journey-timeline">
                    <TimelineList events={events} newestId={newest} />
                    {step >= 2 && step < 4 && <p className="mt-3 text-[11px] text-ink-2">* Sent when your messaging provider is connected.</p>}
                  </div>
                </UiCardLike>
              </div>

              <Card className="self-start" >
                <div className="border-b border-line px-4 py-3">
                  <h3 className="text-[13px] font-semibold text-ink">What the owner sees</h3>
                  <p className="text-[11px] text-ink-2">Hospital funnel · example data</p>
                </div>
                <ul className="space-y-1 px-3 py-3" data-testid="journey-funnel">
                  {HOOK_STAGES.map((s, i) => {
                    const n = counts[i]!;
                    const bumped = changed.includes(i);
                    return (
                      <li key={s.label} className={`rounded-control px-2 py-1.5 transition ${bumped ? "bg-primary-50 ring-1 ring-primary-200" : ""}`}>
                        <div className="flex items-center justify-between gap-2 text-[13px]">
                          <span className="text-ink">{s.label}</span>
                          <span className="flex items-center gap-1.5">
                            {bumped && <span className="mk-rise rounded-chip bg-brand px-1.5 py-px text-[10px] font-semibold text-white">+1</span>}
                            <span className="font-semibold tabular-nums text-ink" data-testid={`journey-count-${i}`}>{n}</span>
                          </span>
                        </div>
                        <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-primary-100" aria-hidden="true">
                          <span className="block h-full rounded-full bg-primary-500 transition-[width] duration-500" style={{ width: `${(n / (counts[0] ?? 1)) * 100}%` }} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-ink-2">Step {step + 1} of {STORY_STEPS.length}</p>
              <button
                type="button"
                onClick={() => setStep(last ? 0 : step + 1)}
                className="inline-flex h-12 items-center gap-2 rounded-control bg-brand px-5 text-[15px] font-semibold text-white shadow-panel transition hover:bg-primary-700"
                data-testid="journey-action"
              >
                {current.action}
                {last ? <RotateCcw size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { CONTAINER, Eyebrow } from "./ui";
import { HOOK_STAGES } from "./content";
import { prefersReducedMotion } from "./motion";

/**
 * "The lead is only the beginning." A deep-navy chapter break: a huge claim, then the staircase from 42 enquiries to 4
 * procedures done. Content is visible without JS; with JS and motion allowed it arrives in sequence once, when in view.
 */
export function HookStory() {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"static" | "hidden" | "shown">("static");

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) return;
    setPhase("hidden");
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setPhase("shown");
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const max = HOOK_STAGES[0].count;

  return (
    <section aria-labelledby="hook-title" className="bg-ink py-20 text-white sm:py-28 lg:py-32">
      <div className={CONTAINER}>
        <Eyebrow className="!text-primary-300">The lead is only the beginning</Eyebrow>
        <h2 id="hook-title" className="mt-5 max-w-[980px] text-balance text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[56px] lg:text-[72px]">
          Your marketing report says 42 enquiries. <span className="text-primary-300">What happened to them?</span>
        </h2>
        <p className="mt-6 max-w-[650px] text-[18px] leading-relaxed text-primary-100 sm:text-[20px]">Most reports stop here. The patient&apos;s story doesn&apos;t.</p>

        <div ref={ref} data-phase={phase} className="mk-hook mt-14 lg:mt-20" data-testid="hook-stairs">
          {/* Desktop: seven columns. */}
          <ol className="hidden items-end gap-4 lg:grid lg:grid-cols-7" aria-label="What happened to 42 enquiries (example data)">
            {HOOK_STAGES.map((s, i) => (
              <li key={s.label} className="mk-hook-item flex flex-col" style={{ "--i": i } as React.CSSProperties}>
                <span className="text-[64px] font-semibold leading-none tabular-nums tracking-[-0.04em]">{s.count}</span>
                <span className="mt-2 min-h-[2.5rem] text-[15px] leading-snug text-primary-100">{s.label}</span>
                <span className="mt-3 flex h-[180px] items-end" aria-hidden="true">
                  <span className="mk-hook-bar block w-full rounded-t-[10px] bg-primary-500" style={{ height: `${(s.count / max) * 100}%`, "--i": i } as React.CSSProperties} />
                </span>
              </li>
            ))}
          </ol>
          {/* Below lg: seven rows. */}
          <ol className="space-y-4 lg:hidden" aria-label="What happened to 42 enquiries (example data)">
            {HOOK_STAGES.map((s, i) => (
              <li key={s.label} className="mk-hook-item" style={{ "--i": i } as React.CSSProperties}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-[15px] text-primary-100">{s.label}</span>
                  <span className="text-[34px] font-semibold leading-none tabular-nums tracking-[-0.03em]">{s.count}</span>
                </div>
                <span className="mt-2 block h-2 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
                  <span className="mk-hook-barx block h-full rounded-full bg-primary-500" style={{ width: `${(s.count / max) * 100}%`, "--i": i } as React.CSSProperties} />
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-10 text-sm text-primary-200">Example journey data (synthetic). Not a customer result.</p>
        </div>
      </div>
    </section>
  );
}

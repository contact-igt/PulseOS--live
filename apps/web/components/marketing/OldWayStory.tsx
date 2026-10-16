"use client";

import { useEffect, useRef, useState } from "react";
import { CONTAINER, Eyebrow } from "./ui";
import { OLD_WAY_TIMELINE, SPREADSHEET } from "./content";
import { prefersReducedMotion } from "./motion";

/**
 * The old way → PulseOS. As the section scrolls through the viewport the follow-up sheet recedes and the timeline takes its
 * place. Driven by ordinary scroll position (no scroll hijack, no library). Reduced motion, no JS, and the first paint all
 * show the finished state (sheet quiet, timeline complete), so nothing is ever hidden.
 */
export function OldWayStory() {
  const ref = useRef<HTMLDivElement>(null);
  const [p, setP] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      setP(Math.min(1, Math.max(0, (vh * 0.9 - r.top) / (vh * 0.55))));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section aria-labelledby="oldway-title" className="mk-section-ice border-y border-line py-20 sm:py-28">
      <div className={CONTAINER}>
        <div className="max-w-[860px]">
          <Eyebrow>The old way</Eyebrow>
          <h2 id="oldway-title" className="mt-4 text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[48px] lg:text-[60px]">
            If your follow-up system looks like this, you already know the problem.
          </h2>
        </div>

        <div ref={ref} className="mt-12 grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.35fr_1fr] lg:gap-10" data-testid="old-way">
          <div className="min-w-0" style={{ opacity: 1 - 0.5 * p, transform: `scale(${1 - 0.03 * p})`, transformOrigin: "left top", transition: "opacity 120ms linear, transform 120ms linear" }}>
            <div className="overflow-hidden rounded-card border border-line-strong bg-white shadow-panel">
              <div className="flex items-center gap-2 border-b border-line-strong bg-neutral-100 px-3 py-1.5 text-[11px] font-medium text-ink-2">
                <span className="h-2 w-2 rounded-full bg-neutral-400" aria-hidden="true" /> follow-up-sheet-FINAL-v3.xlsx
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse text-left text-[12px]" aria-label="A typical follow-up spreadsheet (fictional)">
                  <thead>
                    <tr className="bg-neutral-50">
                      {SPREADSHEET.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap border border-line-strong px-2.5 py-1.5 font-semibold text-ink">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SPREADSHEET.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} className="whitespace-nowrap border border-line-strong px-2.5 py-1.5 text-ink-2">{c}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="mt-3 text-sm text-ink-2">Fictional rows. Day 1 here, Day 2 there, a separate sheet for follow-ups.</p>
          </div>

          <div className="min-w-0">
            <div className="rounded-card border border-primary-300 bg-white p-5 shadow-glass">
              <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
                <p className="text-[15px] font-semibold text-ink">PulseOS · one journey</p>
                <span className="text-xs text-ink-2">Priya · Cataract</span>
              </div>
              <ol className="relative mt-4 space-y-4 border-l border-line pl-6">
                {OLD_WAY_TIMELINE.map((e, i) => {
                  const on = Math.min(1, Math.max(0, (p - (0.1 + i * 0.14)) / 0.2));
                  return (
                    <li key={e.title + i} className="relative" style={{ opacity: on, transform: `translateY(${(1 - on) * 10}px)` }}>
                      <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-white bg-brand" aria-hidden="true" />
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-medium text-ink">{e.title}</span>
                        <span className="text-[11px] tabular-nums text-ink-2">{e.time}</span>
                      </div>
                      <p className="text-xs text-ink-2">{e.detail}</p>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        </div>

        <ul className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="What goes away">
          {["No Day 1.", "No Day 2.", "No separate follow-up sheet."].map((t) => (
            <li key={t} className="rounded-card border border-line bg-white px-5 py-4 text-[20px] font-semibold tracking-tight text-ink">{t}</li>
          ))}
        </ul>
        <p className="mt-5 max-w-[650px] text-[18px] leading-relaxed text-ink-2">Just one chronological patient journey and the next action.</p>
      </div>
    </section>
  );
}

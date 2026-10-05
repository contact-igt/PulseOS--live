"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface TabItem {
  key: string;
  label: string;
  count?: number;
  testId?: string;
}

const EDGE_PX = 28;
const FADE_BOTH = `linear-gradient(to right, transparent 0, #000 ${EDGE_PX}px, #000 calc(100% - ${EDGE_PX}px), transparent 100%)`;
const FADE_END = `linear-gradient(to right, #000 calc(100% - ${EDGE_PX}px), transparent 100%)`;
const FADE_START = `linear-gradient(to right, transparent 0, #000 ${EDGE_PX}px)`;

/**
 * Segmented control / tab strip. Scrolls horizontally inside its own box on narrow screens (never
 * widens the page and never scrolls vertically: `overflow-y-hidden`, and the underline indicator is
 * an inset shadow, not a negative margin that would overhang the scroll box). An edge fade tells
 * the user there are more tabs off-screen. `segmented` is a pill group, `underline` a flat tab row
 * for page-level sections. Arrow keys / Home / End move between tabs (roving tabindex).
 *
 * When the tabs do not all fit, a ‹ / › button appears on the side that has more (only there): a plain mouse user
 * has no trackpad or shift-wheel, so the hidden tabs must be reachable by clicking. Trackpad, touch and keyboard
 * keep working exactly as before. The buttons float over the edge fade, so they never change the layout.
 */
export function Tabs({
  items,
  value,
  onChange,
  variant = "segmented",
  ariaLabel,
  className = "",
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  variant?: "segmented" | "underline";
  ariaLabel?: string;
  className?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { start: max > 1 && el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 };
    setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  const scrollByPage = (dir: -1 | 1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(120, Math.round(el.clientWidth * 0.7)), behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  useLayoutEffect(measure, [measure, items.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    window.addEventListener("resize", measure);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [measure]);

  // Keep the selected tab visible (deep links, arrow keys, narrow screens).
  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    const target = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (target < 0) return;
    e.preventDefault();
    const next = items[target];
    if (!next) return;
    onChange(next.key);
    requestAnimationFrame(() => stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus());
  };

  const wrap =
    variant === "segmented"
      ? "glass inline-flex max-w-full gap-0.5 rounded-control p-0.5"
      : "flex max-w-full gap-5 border-b border-line";
  const mask = fade.start && fade.end ? FADE_BOTH : fade.end ? FADE_END : fade.start ? FADE_START : undefined;

  const arrow = "absolute top-0 z-10 flex h-full min-h-11 w-9 items-center justify-center rounded-control text-ink-2 hover:text-ink focus-visible:outline-offset-[-2px] sm:w-7";
  return (
    <div className={`relative max-w-full min-w-0 ${variant === "segmented" ? "inline-block align-top" : "block"}`}>
    {fade.start && (
      <button type="button" aria-label="Scroll tabs left" tabIndex={-1} onClick={() => scrollByPage(-1)} className={`${arrow} left-0 bg-white/90`} data-testid="tabs-scroll-left">
        <ChevronLeft size={16} aria-hidden="true" />
      </button>
    )}
    {fade.end && (
      <button type="button" aria-label="Scroll tabs right" tabIndex={-1} onClick={() => scrollByPage(1)} className={`${arrow} right-0 bg-white/90`} data-testid="tabs-scroll-right">
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    )}
    <div
      ref={stripRef}
      role="tablist"
      aria-label={ariaLabel}
      onScroll={measure}
      data-fade-start={fade.start ? "" : undefined}
      data-fade-end={fade.end ? "" : undefined}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className={`${wrap} overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {items.map((t, i) => {
        const active = t.key === value;
        const cls =
          variant === "segmented"
            ? `rounded-lg px-2.5 py-1 text-xs font-medium max-md:min-h-11 ${active ? "bg-white text-primary-800 shadow-panel" : "text-ink-2 hover:bg-white/60 hover:text-ink"}`
            : `px-0.5 pb-2.5 pt-2 text-sm font-medium max-md:min-h-11 ${active ? "text-primary-700 shadow-[inset_0_-2px_0_var(--color-primary-600)]" : "text-ink-2 hover:text-ink"}`;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            // The strip clips its children, so the focus ring is drawn INSIDE the tab (an outer ring would be cut off).
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap transition focus-visible:outline-offset-[-2px] ${cls}`}
            data-testid={t.testId}
          >
            {t.label}
            {t.count !== undefined && <span className={`tabular-nums ${active ? "text-primary-700" : "text-neutral-500"}`}>{t.count}</span>}
          </button>
        );
      })}
    </div>
    </div>
  );
}

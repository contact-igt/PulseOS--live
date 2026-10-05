"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { isDayKey, localDayKey, type CalendarMode } from "@pulseos/ui";
import { replaceUrlParams } from "./urlParams";

export type ViewRange = "day" | "week" | "month";
const RANGES: readonly ViewRange[] = ["day", "week", "month"];

export interface ViewState<V extends string> {
  view: V;
  /** Selected day, `yyyy-mm-dd` in `timeZone` (defaults to today there). */
  date: string;
  range: ViewRange;
  /** What a calendar shows: the range grid, or Agenda (`cal=agenda`) listing that same span. */
  calendarMode: CalendarMode;
}

export interface UseViewStateOptions<V extends string> {
  /** Allowed `view` values; anything else in the URL falls back to `defaultView`. */
  views: readonly V[];
  defaultView: V;
  defaultRange?: ViewRange;
  /** Hospital/tenant IANA zone - decides what "today" is when `date` is absent. */
  timeZone: string;
}

/**
 * URL-backed view state: ONLY `view`, `date`, `range` and `cal` (Agenda). Refresh, back/forward
 * and shared links restore the same view. Every other query param (filters, page,
 * search) is left exactly as it was - this hook is not a filter store.
 * Writes go through `replaceUrlParams` (history.replaceState on the live URL), so
 * switching views is instant, never adds history entries or jumps the page, and
 * several updates in one handler (open a day = date + Day mode) all land.
 *
 * Call sites need a Suspense boundary above them only if the page is statically
 * rendered; pages under the authenticated `(app)` layout are dynamic.
 */
export function useViewState<V extends string>({ views, defaultView, defaultRange = "week", timeZone }: UseViewStateOptions<V>) {
  const params = useSearchParams();

  const rawView = params.get("view");
  const rawDate = params.get("date");
  const rawRange = params.get("range");
  const agenda = params.get("cal") === "agenda";

  const state = useMemo<ViewState<V>>(() => {
    const range = RANGES.find((r) => r === rawRange) ?? defaultRange;
    return {
      view: views.find((v) => v === rawView) ?? defaultView,
      date: isDayKey(rawDate) ? rawDate : localDayKey(new Date(), timeZone),
      range,
      calendarMode: agenda ? "agenda" : range,
    };
  },
    // `views` is a caller-supplied constant; its identity changing must not churn state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawView, rawDate, rawRange, agenda, defaultView, defaultRange, timeZone],
  );

  /** Patch any of view/date/range in one navigation. A value equal to its default (view, range) is dropped from the URL. */
  const setState = useCallback(
    (patch: Partial<Omit<ViewState<V>, "calendarMode">> & { agenda?: boolean }) => {
      const write: Record<string, string | undefined> = {};
      if ("view" in patch) write.view = patch.view === defaultView ? undefined : patch.view;
      if ("date" in patch) write.date = patch.date;
      if ("range" in patch) write.range = patch.range === defaultRange ? undefined : patch.range;
      if ("agenda" in patch) write.cal = patch.agenda ? "agenda" : undefined;
      replaceUrlParams(write);
    },
    [defaultView, defaultRange],
  );

  return {
    ...state,
    setView: useCallback((view: V) => setState({ view }), [setState]),
    setDate: useCallback((date: string) => setState({ date }), [setState]),
    setRange: useCallback((range: ViewRange) => setState({ range }), [setState]),
    /** Agenda keeps the current range as its span; a grid mode clears Agenda and becomes the range. */
    setCalendarMode: useCallback((mode: CalendarMode) => setState(mode === "agenda" ? { agenda: true } : { agenda: false, range: mode }), [setState]),
    setState,
  };
}

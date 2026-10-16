import { useRef, type KeyboardEvent } from "react";

/** WAI-ARIA tabs keyboard model: arrows (and Home/End) move focus + selection across the tab list. */
export function useTabKeys(count: number, active: number, select: (i: number) => void, orientation: "horizontal" | "vertical" = "horizontal") {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const prevKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";

  function onKeyDown(e: KeyboardEvent) {
    let next = active;
    if (e.key === nextKey) next = (active + 1) % count;
    else if (e.key === prevKey) next = (active - 1 + count) % count;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else return;
    e.preventDefault();
    select(next);
    refs.current[next]?.focus();
  }

  const setRef = (i: number) => (el: HTMLElement | null) => {
    refs.current[i] = el;
  };
  return { onKeyDown, setRef };
}

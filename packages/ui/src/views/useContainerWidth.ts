"use client";

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Width (px) of the element the returned ref is attached to, tracked with a
 * ResizeObserver. `null` until measured (first paint / SSR / jsdom without
 * ResizeObserver) - callers treat null as "wide" so there is no fallback flash
 * on desktop.
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 0 means "not laid out" (display:none, jsdom): treat as unmeasured, not as a phone.
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setWidth(w > 0 ? w : null);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}

/** Container width below which grid views hand over to their list fallback. */
export const VIEW_MOBILE_BREAKPOINT = 640;

"use client";

import { useEffect, useState } from "react";

/** True below the tablet breakpoint (768px). Server and first paint assume wide; it settles on mount. */
export function useIsNarrow(maxWidth = 767): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [maxWidth]);
  return narrow;
}

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Text that is cut off with an ellipsis, and says so: the full text becomes the tooltip ONLY when it really is truncated.
 * Measured on mount and whenever the box resizes (not on hover), so keyboard and touch users get it too: the label sits
 * inside a link, and the link — not this span — takes focus.
 */
export function TruncatedText({ children, className = "", as: Tag = "span" }: { children: ReactNode; className?: string; as?: "span" | "p" }) {
  const ref = useRef<HTMLElement>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTitle(el.scrollWidth > el.clientWidth ? el.textContent ?? undefined : undefined);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);
  return (
    <Tag ref={ref as never} className={`truncate ${className}`} title={title}>
      {children}
    </Tag>
  );
}

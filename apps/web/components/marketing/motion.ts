/** True when the visitor asked for reduced motion (or the browser cannot say). Scroll/reveal effects must then show their finished state. */
export function prefersReducedMotion(): boolean {
  return typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

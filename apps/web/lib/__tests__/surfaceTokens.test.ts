import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The interface-style tokens live in globals.css. Whatever a hospital picks, readability floors hold: a menu, a card or a
// form can never become see-through. This pins the numbers so nobody widens them by accident.

const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const FAMILIES = ["floating", "content", "glass", "glass-strong", "control"] as const;
const FLOOR: Record<(typeof FAMILIES)[number], number> = { floating: 0.92, content: 0.94, glass: 0.85, "glass-strong": 0.88, control: 0.8 };

function block(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
}
const alpha = (b: string, family: string) => Number(new RegExp(`--alpha-${family}:\\s*([0-9.]+)`).exec(b)?.[1]);

describe("interface style tokens", () => {
  const styles = { airy: block('[data-surface="airy"]'), balanced: block('[data-surface="balanced"]'), solid: block('[data-surface="solid"]') };

  it("every style defines every family, never below its readability floor", () => {
    for (const [name, b] of Object.entries(styles)) for (const f of FAMILIES) expect(alpha(b, f), `${name} ${f}`).toBeGreaterThanOrEqual(FLOOR[f]);
  });

  it("airy <= balanced <= solid for every family (the options are ordered), and solid floating/content are fully opaque", () => {
    for (const f of FAMILIES) {
      expect(alpha(styles.airy, f)).toBeLessThanOrEqual(alpha(styles.balanced, f));
      expect(alpha(styles.balanced, f)).toBeLessThanOrEqual(alpha(styles.solid, f));
    }
    expect(alpha(styles.solid, "floating")).toBe(1);
    expect(alpha(styles.solid, "content")).toBe(1);
  });

  it("the default (:root) is the Balanced set, which is more opaque than the old translucent material (0.66 / 0.82 / 0.72)", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("--z-sticky"));
    for (const f of FAMILIES) expect(alpha(root, f), f).toBe(alpha(styles.balanced, f));
    expect(alpha(styles.balanced, "glass")).toBeGreaterThan(0.66);
    expect(alpha(styles.balanced, "glass-strong")).toBeGreaterThan(0.82);
    expect(alpha(styles.balanced, "control")).toBeGreaterThan(0.72);
  });

  it("the surface classes read the tokens (no scattered opacity numbers), and floating menus drop blur on phones", () => {
    expect(block(".floating")).toContain("var(--alpha-floating)");
    expect(block(".surface-content")).toContain("var(--alpha-content)");
    expect(css).toMatch(/\.glass\s*\{\s*background-color:\s*rgb\(255 255 255 \/ var\(--alpha-glass\)\)/);
    expect(css).toMatch(/\.glass-strong\s*\{\s*background-color:\s*rgb\(255 255 255 \/ var\(--alpha-glass-strong\)\)/);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.floating\s*\{[^}]*backdrop-filter:\s*none/);
  });

  it("one z-index scale: sticky < dropdown < sheet < dialog < popover < toast < overlay", () => {
    const z = (name: string) => Number(new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]);
    const order = ["sticky", "dropdown", "sheet", "dialog", "popover", "toast", "overlay"].map(z);
    expect(order.every((n) => Number.isFinite(n))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

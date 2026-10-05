import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { colors, shell, spacing, typography } from "../index";

describe("design tokens contract", () => {
  it("primary color scale is complete from 50 to 900", () => {
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
    for (const step of steps) {
      expect(colors.primary[step]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("warning and danger scales exist for operational alerts only", () => {
    expect(colors.warning[500]).toBeDefined();
    expect(colors.danger[500]).toBeDefined();
  });

  it("spacing scale follows a 4px rhythm", () => {
    expect(spacing[1]).toBe("4px");
    expect(spacing[2]).toBe("8px");
    expect(spacing[4]).toBe("16px");
  });

  it("typography scale defines every named step", () => {
    for (const key of ["xs", "sm", "base", "md", "lg", "xl"] as const) {
      expect(typography.scale[key].size).toMatch(/px$/);
    }
  });

  it("globals.css @theme mirrors the TS colour scales, semantic roles and shell tokens", () => {
    const css = readFileSync(resolve(__dirname, "../../../../apps/web/app/globals.css"), "utf8");
    const expectVar = (name: string, value: string) => expect(css, name).toContain(`${name}: ${value};`);
    for (const [step, hex] of Object.entries(colors.primary)) expectVar(`--color-primary-${step}`, hex);
    for (const [step, hex] of Object.entries(colors.neutral)) expectVar(`--color-neutral-${step}`, hex);
    expectVar("--color-canvas-base", colors.canvas.base);
    expectVar("--color-canvas-bright", colors.canvas.bright);
    expectVar("--color-brand", colors.brand.DEFAULT);
    expectVar("--color-brand-deep", colors.brand.deep);
    expectVar("--color-brand-soft", colors.brand.soft);
    expectVar("--color-surface", colors.surface.DEFAULT);
    expectVar("--color-surface-muted", colors.surface.muted);
    expectVar("--color-surface-info", colors.surface.info);
    expectVar("--color-surface-glass", colors.surface.glass);
    expectVar("--color-surface-glass-strong", colors.surface.glassStrong);
    expectVar("--color-line", colors.border.DEFAULT);
    expectVar("--color-line-strong", colors.border.strong);
    expectVar("--color-glass-border", colors.border.glass);
    expectVar("--color-ink", colors.text.primary);
    expectVar("--color-ink-2", colors.text.secondary);
    expectVar("--color-focus-ring", colors.focusRing);
    expectVar("--radius-shell", shell.radiusShell);
    expectVar("--radius-panel", shell.radiusPanel);
    expectVar("--radius-card", shell.radiusCard);
    expectVar("--radius-control", shell.radiusControl);
    expectVar("--radius-chip", shell.radiusChip);
    expectVar("--shadow-glass", shell.shadowGlass);
    expectVar("--shadow-panel", shell.shadowPanel);
    expectVar("--glass-blur", shell.glassBlur);
  });

  it("the glass material has an @supports fallback and no purple/pink brand colours exist", () => {
    const css = readFileSync(resolve(__dirname, "../../../../apps/web/app/globals.css"), "utf8");
    expect(css).toContain("@supports not ((backdrop-filter: blur(1px))");
    const hues = Object.values({ ...colors.primary, ...colors.neutral }).map((hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return { r, g, b };
    });
    // Blue-family only: blue channel always dominates or ties for the brand + neutral ramps.
    for (const { r, b } of hues) expect(b).toBeGreaterThanOrEqual(r);
  });
});

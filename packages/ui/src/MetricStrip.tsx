import type { CSSProperties } from "react";

export interface MetricCellDef {
  key: string;
  label: string;
  value: string | number;
  onClick?: () => void;
  testId?: string;
  /** Needs attention (e.g. overdue): the value turns the danger colour while it is above zero. */
  attention?: boolean;
}

/**
 * One connected panel of metric cells with hairline internal dividers — the
 * pattern every reference dashboard uses instead of N separate floating cards.
 * The strip adapts its column count to the number of cells.
 *
 * `anchorKey` marks ONE cell as the anchor metric (the blue emphasis surface). Use it for the single number the page is about,
 * never for several cells at once.
 */
export function MetricStrip({
  cells,
  testId,
  anchorKey,
  activeKey,
  layout = "stacked",
  ariaLabel,
}: {
  cells: MetricCellDef[];
  testId?: string;
  anchorKey?: string;
  /** The cell whose filter is currently open (cells become toggle buttons). Shown by a solid tint AND an underline bar, never colour alone. */
  activeKey?: string;
  /** "stacked": value above label. "inline": label left, value right on one line (compact strips above a list). */
  layout?: "stacked" | "inline";
  ariaLabel?: string;
}) {
  const n = cells.length;
  const smCols = n <= 4 ? Math.max(n, 1) : 3;
  const style = { "--sm-cols": smCols, "--lg-cols": Math.max(n, 1) } as CSSProperties;
  const lastIndex = n - 1;

  // Only the last cell can leave a hole in a wrapped grid; let it span the rest of its row.
  function lastCellSpan(index: number): string {
    if (index !== lastIndex) return "";
    const mobile = n % 2 === 1 ? "max-sm:col-span-2 " : "";
    const rest = n % smCols === 1 ? "sm:max-lg:col-span-full" : n % smCols === 2 && smCols === 3 ? "sm:max-lg:col-span-2" : "";
    return mobile + rest;
  }

  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-panel sm:[grid-template-columns:repeat(var(--sm-cols),minmax(0,1fr))] lg:[grid-template-columns:repeat(var(--lg-cols),minmax(0,1fr))]"
      style={style}
      data-testid={testId}
      {...(ariaLabel ? { role: "group", "aria-label": ariaLabel } : {})}
    >
      {cells.map((cell, index) => {
        const cellTestId = cell.testId ?? `metric-${cell.key}`;
        const anchor = anchorKey !== undefined && anchorKey === cell.key;
        const active = activeKey !== undefined && activeKey === cell.key;
        // Every surface is SOLID and the container clips them to its one radius, so a tinted/hovered cell can never poke past a rounded corner.
        const surface = anchor ? "bg-primary-700 text-white" : active ? "bg-primary-50 shadow-[inset_0_-2px_0_0_var(--color-brand)]" : "bg-surface";
        const valueTone = anchor ? "text-white" : cell.attention && Number(cell.value) > 0 ? "text-danger-700" : "text-ink";
        const labelTone = anchor ? "text-primary-100" : active ? "text-ink" : "text-ink-2";
        const content =
          layout === "inline" ? (
            <>
              <span className={`min-w-0 truncate text-xs font-medium leading-tight ${labelTone}`}>{cell.label}</span>
              <span className={`shrink-0 text-base font-semibold leading-none tabular-nums ${valueTone}`} data-testid={`${cellTestId}-count`}>{cell.value}</span>
            </>
          ) : (
            <>
              <span className={`block text-xl font-semibold leading-none tabular-nums ${valueTone}`} data-testid={`${cellTestId}-count`}>{cell.value}</span>
              <span className={`mt-1.5 block text-xs font-medium leading-tight ${labelTone}`}>{cell.label}</span>
            </>
          );
        const layoutClass = layout === "inline" ? "flex items-center justify-between gap-3 px-4 py-2.5 max-md:min-h-11" : "flex flex-col items-start px-4 py-3";
        const span = lastCellSpan(index);
        return cell.onClick ? (
          <button
            key={cell.key}
            type="button"
            onClick={cell.onClick}
            aria-pressed={activeKey !== undefined ? active : undefined}
            className={`min-w-0 text-left transition focus-visible:[outline-offset:-2px] ${layoutClass} ${anchor ? "hover:bg-primary-800" : "hover:bg-primary-50"} ${surface} ${span}`}
            data-testid={cellTestId}
          >
            {content}
          </button>
        ) : (
          <div key={cell.key} className={`min-w-0 ${layoutClass} ${surface} ${span}`} data-testid={cellTestId}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

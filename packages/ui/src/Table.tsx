import { isValidElement } from "react";
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { Badge } from "./primitives";

// The shared table grammar — Patients/Leads/Treatments/Journeys/Campaign
// Detail/Integrations already agreed on nearly this exact rhythm before
// this extraction (confirmed by reading all six), so this is a thin,
// no-behavior wrapper around native <table> markup that removes the
// className duplication, not a new generic DataTable abstraction. Compact
// row height is deliberate — PulseOS's own VISUAL_DENSITY=8 target calls for
// dense, not spacious, tables: ~32-36px single-line rows, a muted uppercase
// header band, and a soft blue hover.

export function Table({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <table className={`w-full border-collapse text-left text-xs text-ink ${className}`}>{children}</table>;
}

/** `sticky` pins the header cells to the top of the nearest scroll container (give that container a max-height). */
export function TableHead({ children, sticky = false }: { children: ReactNode; sticky?: boolean }) {
  return <thead className={`border-b border-line ${sticky ? "[&_th]:sticky [&_th]:top-0 [&_th]:z-[1]" : ""}`}>{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-neutral-100">{children}</tbody>;
}

export function Tr({
  children,
  onClick,
  className = "",
  ...rest
}: { children: ReactNode; onClick?: () => void; className?: string } & HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={`${onClick ? "cursor-pointer " : ""}transition-colors hover:bg-primary-50/50 ${className}`} onClick={onClick} {...rest}>
      {children}
    </tr>
  );
}

interface CellProps {
  children: ReactNode;
  /** The leading identity column gets a wider gutter (px-4) than interior columns (px-2.5). */
  leading?: boolean;
  align?: "left" | "right" | "center";
  /**
   * Force single-line (true) or allow wrapping (false). When omitted, cells
   * holding a Badge, a number, or a short string (<= 24 chars: dates, phones,
   * owner names, statuses) stay on one line; longer free text wraps.
   */
  nowrap?: boolean;
  className?: string;
}

const ALIGN_CLASS = { left: "", right: "text-right tabular-nums", center: "text-center tabular-nums" } as const;

const SHORT_TEXT = 24;

const isLongText = (children: ReactNode) => typeof children === "string" && children.length > SHORT_TEXT;

function shouldNoWrap(children: ReactNode): boolean {
  if (typeof children === "number") return true;
  if (typeof children === "string") return children.length <= SHORT_TEXT;
  if (isValidElement(children)) return children.type === Badge;
  return false;
}

export function Th({ children, leading = false, align = "left", nowrap = true, className = "", ...rest }: CellProps & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={`${leading ? "px-4" : "px-2.5"} bg-surface-muted py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-2 ${nowrap ? "whitespace-nowrap" : ""} ${align === "right" ? "text-right" : align === "center" ? "text-center" : ""} ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, leading = false, align = "left", nowrap, className = "", ...rest }: CellProps & TdHTMLAttributes<HTMLTableCellElement>) {
  const noWrap = nowrap ?? shouldNoWrap(children);
  return (
    <td className={`${leading ? "px-4" : "px-2.5"} py-2 align-middle ${noWrap ? "whitespace-nowrap" : nowrap === undefined && isLongText(children) ? "min-w-[11rem]" : ""} ${ALIGN_CLASS[align]} ${className}`} {...rest}>
      {children}
    </td>
  );
}

/** Card wrapper for a table: rounded, bordered, scrolls horizontally on narrow screens. `maxHeight` (e.g. "28rem") enables vertical scroll for a sticky header. */
export function TableShell({ children, maxHeight, className = "" }: { children: ReactNode; maxHeight?: string; className?: string }) {
  return (
    <div
      className={`overflow-x-auto rounded-card border border-line bg-surface shadow-panel ${maxHeight ? "overflow-y-auto" : ""} ${className}`}
      style={maxHeight ? { maxHeight } : undefined}
    >
      {children}
    </div>
  );
}

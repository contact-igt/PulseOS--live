import type { Tone } from "../status";

/**
 * Tonal chip styles for calendar events and Gantt bars: pale fill, dark ink,
 * a coloured leading edge. Text stays dark on every tone so contrast never
 * depends on the tone colour; warning/danger are for genuine status only.
 */
export const CHIP_TONE: Record<Tone, string> = {
  primary: "bg-primary-100 border-l-primary-500 hover:bg-primary-200/70",
  neutral: "bg-neutral-100 border-l-neutral-400 hover:bg-neutral-200/70",
  success: "bg-accent-100 border-l-accent-500 hover:bg-accent-300/50",
  warning: "bg-warning-100 border-l-warning-500 hover:bg-warning-100/70",
  danger: "bg-danger-100 border-l-danger-500 hover:bg-danger-100/70",
};

export const BAR_TONE: Record<Tone, string> = {
  primary: "bg-primary-500",
  neutral: "bg-neutral-400",
  success: "bg-accent-500",
  warning: "bg-warning-500",
  danger: "bg-danger-500",
};

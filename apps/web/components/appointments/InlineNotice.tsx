"use client";

/** Inline, dismissible error for a rejected appointment action (never the Next.js error overlay). */
export function InlineNotice({ message, onDismiss, testId }: { message: string; onDismiss: () => void; testId: string }) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-card border border-danger-500/30 bg-danger-100 px-3 py-2 text-xs text-danger-700"
      data-testid={testId}
    >
      <span className="min-w-0 break-words">{message}</span>
      <button type="button" onClick={onDismiss} className="min-h-6 shrink-0 font-medium underline-offset-2 hover:underline">
        Dismiss
      </button>
    </div>
  );
}

"use client";

import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

// Shared form pieces for the Settings editors. 44px targets on a phone, compact on desktop.
export const CONTROL = "h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-neutral-500 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-ink-2 sm:h-9";

export function FormField({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-2">{hint}</p>}
    </div>
  );
}

export function TextInput({ label, hint, ...props }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FormField label={label} hint={hint} htmlFor={id}>
      <input id={id} className={CONTROL} {...props} />
    </FormField>
  );
}

export function SelectInput({ label, hint, children, ...props }: { label: string; hint?: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FormField label={label} hint={hint} htmlFor={id}>
      <select id={id} className={CONTROL} {...props}>
        {children}
      </select>
    </FormField>
  );
}

/**
 * A checkbox that is a 44px touch target on a phone and compact on desktop: the real input fills the target (invisible), the box
 * you see is drawn on top, so the click area is large while the look stays small. Keyboard focus and screen readers use the input.
 */
export function TouchCheckbox({ id, checked, disabled, onChange, testId, ariaLabel }: { id?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; testId?: string; ariaLabel?: string }) {
  return (
    <span className="relative inline-grid h-11 w-11 shrink-0 place-items-center sm:h-5 sm:w-5">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked)} className="peer absolute inset-0 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" data-testid={testId} />
      <span aria-hidden="true" className="pointer-events-none grid h-5 w-5 place-items-center rounded border border-line-strong bg-white text-white peer-checked:border-primary-600 peer-checked:bg-primary-600 peer-checked:[&>svg]:block peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500/40 peer-disabled:opacity-50 sm:h-4 sm:w-4">
        <svg viewBox="0 0 12 12" className="hidden h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.5l2.5 2.5 4.5-5" />
        </svg>
      </span>
    </span>
  );
}

export function CheckRow({ label, hint, checked, onChange, disabled, testId }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; testId?: string }) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-1 py-0 sm:min-h-0 sm:items-start sm:gap-2.5 sm:py-1">
      <TouchCheckbox id={id} checked={checked} disabled={disabled} onChange={onChange} testId={testId} />
      <label htmlFor={id} className="text-sm text-ink sm:mt-px">
        {label}
        {hint && <span className="mt-0.5 block text-[11px] leading-snug text-ink-2">{hint}</span>}
      </label>
    </div>
  );
}

/** An inline, non-blocking error that keeps whatever was typed. */
export function FormError({ message, testId = "form-error" }: { message: string | null; testId?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-control border border-danger-100 bg-danger-100/60 px-3 py-2 text-xs text-danger-700" data-testid={testId}>
      {message}
    </p>
  );
}

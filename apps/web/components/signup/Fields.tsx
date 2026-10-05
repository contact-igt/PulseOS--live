"use client";

import type { ReactNode } from "react";

const INPUT =
  "h-11 w-full rounded-control border bg-white px-3.5 text-sm text-slate-900 outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 placeholder:text-neutral-400";

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  optional,
  type = "text",
  autoComplete,
  inputMode,
  maxLength,
  right,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  optional?: boolean;
  type?: string;
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "tel" | "email";
  maxLength?: number;
  right?: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-xs font-medium text-neutral-600">
        <span>{label}</span>
        {optional && <span className="font-normal text-neutral-500">Optional</span>}
      </label>
      <div className="relative">
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          inputMode={inputMode}
          maxLength={maxLength}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`${INPUT} ${error ? "border-danger-500" : "border-line-strong"} ${right ? "pr-11" : ""}`}
          data-testid={`signup-field-${id}`}
        />
        {right}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-danger-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A single-choice group as buttons (a radiogroup): friendlier than a native dropdown for short lists. */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
  testId,
  columns = "grid-cols-2",
}: {
  label: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T) => void;
  error?: string;
  testId: string;
  columns?: string;
}) {
  return (
    <div>
      <p id={`${testId}-label`} className="mb-1.5 text-xs font-medium text-neutral-600">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={`${testId}-label`} className={`grid gap-1.5 ${columns}`} data-testid={testId}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            onClick={() => onChange(o)}
            className={`min-h-11 rounded-control border px-2.5 py-2 text-left text-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 ${
              value === o ? "border-primary-500 bg-primary-50 font-semibold text-primary-800" : "border-line-strong bg-white text-neutral-700 hover:border-primary-300 hover:bg-primary-50/50"
            }`}
            data-testid={`${testId}-${o}`}
          >
            {o}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

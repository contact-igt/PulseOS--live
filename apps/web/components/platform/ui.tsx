"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RotateCw, Search } from "lucide-react";
import { Badge, Button, Skeleton, useDialogFocus } from "@pulseos/ui";
import { ApiError } from "@pulseos/api-client";
import { TENANT_STATUS_LABEL, type PlatformUserStatus, type TenantEnvironment, type TenantStatus, type UserStatus } from "@pulseos/types";

/** Every Platform Console date and time is shown in India time (the company's own zone), with the zone named. */
const IST = "Asia/Kolkata";
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "Never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) return fmtWhen(iso);
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDay(iso);
}

/** A safe, human message for a failed request: never a stack trace or a raw server string. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Your platform role does not allow this.";
    if (err.status === 404) return "Not found. It may have been removed, or you may not have access.";
    if (err.status === 409) return conflictMessage(err.message) ?? "This changed since you opened it. Reload and try again.";
    if (err.status === 429) return "Too many attempts. Please wait a minute and try again.";
    if (err.status === 400 && err.issues.length) return err.issues.map((i) => i.message).join(" ");
    if (err.status >= 500) return "The server could not complete this. Please try again.";
    return fallback;
  }
  return "Could not reach PulseOS. Check your connection and try again.";
}

const CONFLICTS: Record<string, string> = {
  stale_version: "Someone else changed this since you opened it. Reload to see their change, then try again.",
  invalid_transition: "That status change is not allowed from the current status.",
  slug_taken: "That login address is already in use.",
  email_in_use: "That person already belongs to this hospital.",
  last_tenant_admin: "This would leave the hospital without an active administrator.",
  last_platform_owner: "There must always be at least one active Platform Owner.",
  self_change: "You cannot change your own platform access.",
  requires: "Switch on the capabilities it depends on first.",
  required_by: "Other capabilities depend on this one. Switch those off first.",
  locked: "This capability is part of the core product and cannot be switched off.",
  already_member: "That person already belongs to this hospital.",
  not_pending: "This invitation is no longer pending.",
  support_session_active: "You already have an active support session for this hospital.",
};
function conflictMessage(code: string): string | null {
  return CONFLICTS[code] ?? null;
}

export function PlatformPage({ title, subtitle, actions, back, children, testId }: { title: string; subtitle?: string; actions?: ReactNode; back?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-4" data-testid={testId}>
      <div className="space-y-1">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-56">
            <h1 className="break-words text-xl font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
          </div>
          {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Inline error with a Retry button. Used by every major surface instead of a blank panel. */
export function ErrorPanel({ error, onRetry, testId = "platform-error" }: { error: unknown; onRetry?: () => void; testId?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-danger-100 bg-danger-100/40 px-4 py-3 text-sm text-danger-700" data-testid={testId}>
      <span>{errorMessage(error, "Could not load this. Please try again.")}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RotateCw size={13} /> Retry
        </Button>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className="h-4" />
          ))}
        </div>
      ))}
    </div>
  );
}

const TENANT_TONE: Record<TenantStatus, "neutral" | "warning" | "danger" | "primary" | "success"> = {
  DRAFT: "neutral",
  ONBOARDING: "primary",
  ACTIVE: "success",
  SUSPENDED: "danger",
  ARCHIVED: "neutral",
};
export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  return (
    <span data-tenant-status={status}>
      <Badge tone={TENANT_TONE[status]}>{TENANT_STATUS_LABEL[status].label}</Badge>
    </span>
  );
}

export function EnvironmentBadge({ environment }: { environment: TenantEnvironment }) {
  if (environment === "PRODUCTION") return null;
  return <Badge tone="warning">{environment === "DEMO" ? "Demo" : "Test"}</Badge>;
}

const USER_TONE: Record<UserStatus | PlatformUserStatus, "neutral" | "warning" | "danger" | "primary" | "success"> = { ACTIVE: "success", INVITED: "primary", SUSPENDED: "danger", REMOVED: "neutral" };
const USER_LABEL: Record<UserStatus | PlatformUserStatus, string> = { ACTIVE: "Active", INVITED: "Invited", SUSPENDED: "Suspended", REMOVED: "Removed" };
export function AccountStatusBadge({ status }: { status: UserStatus | PlatformUserStatus }) {
  return <Badge tone={USER_TONE[status]}>{USER_LABEL[status]}</Badge>;
}

export function Pager({ page, pageSize, total, onPage, testId = "pager" }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; testId?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-ink-2" data-testid={testId}>
      <span>
        {from}–{to} of {total}
      </span>
      <span className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft size={14} />
        </Button>
        <span className="tabular-nums">
          Page {page} of {pages}
        </span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronRight size={14} />
        </Button>
      </span>
    </div>
  );
}

/** Search box that reports its value after the person stops typing (the server does the searching). */
export function SearchBox({ value, onChange, placeholder, label, testId }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; testId?: string }) {
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <label className="glass-control col-span-2 flex h-11 w-full min-w-0 items-center gap-2 rounded-control px-2.5 sm:h-8 sm:w-64">
      <Search size={14} className="shrink-0 text-neutral-500" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-neutral-500" data-testid={testId} />
    </label>
  );
}

/**
 * Confirmation for a consequential platform action. States the consequence, optionally requires a reason (audited) and, for the
 * most dangerous actions, typing a word to confirm. Never reports success itself: the caller shows the server's answer.
 */
export function ActionDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  requireReason = false,
  typedConfirmation,
  pending = false,
  error,
  onConfirm,
  onCancel,
  children,
  confirmDisabled = false,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  /** The exact word the person must type (e.g. the tenant's slug or SUSPEND). */
  typedConfirmation?: string;
  pending?: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
}) {
  const ref = useDialogFocus<HTMLDivElement>(open, onCancel);
  const reasonId = useId();
  const typedId = useId();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason("");
      setTyped("");
    }
  }
  if (!open) return null;
  const reasonOk = !requireReason || reason.trim().length >= 5;
  const typedOk = !typedConfirmation || typed.trim() === typedConfirmation;
  return (
    <div className="fixed inset-0 z-(--z-dialog) flex items-center justify-center p-4" role="alertdialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Cancel" tabIndex={-1} onClick={onCancel} className="drawer-backdrop absolute inset-0 bg-slate-900/40" />
      <div ref={ref} tabIndex={-1} className="dialog-panel relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-panel p-5 focus:outline-none" data-testid="action-dialog">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{description}</p>
        {children && <div className="mt-3">{children}</div>}
        {requireReason && (
          <div className="mt-3 space-y-1">
            <label htmlFor={reasonId} className="block text-xs font-medium text-ink">
              Reason <span className="font-normal text-ink-2">(recorded in the audit trail)</span>
            </label>
            <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} className="w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25" data-testid="action-dialog-reason" />
            {!reasonOk && reason.length > 0 && <p className="text-[11px] text-ink-2">At least 5 characters.</p>}
          </div>
        )}
        {typedConfirmation && (
          <div className="mt-3 space-y-1">
            <label htmlFor={typedId} className="block text-xs font-medium text-ink">
              Type <span className="font-mono font-semibold">{typedConfirmation}</span> to confirm
            </label>
            <input id={typedId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="h-11 w-full rounded-control border border-line-strong bg-surface px-3 font-mono text-sm text-ink outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/25 sm:h-9" data-testid="action-dialog-typed" />
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-3 rounded-control bg-danger-100/60 px-3 py-2 text-xs text-danger-700" data-testid="action-dialog-error">
            {errorMessage(error)}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={onCancel} data-testid="action-dialog-cancel">
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} className={danger ? "border-danger-500 bg-danger-500 text-white hover:bg-danger-700" : ""} disabled={pending || !reasonOk || !typedOk || confirmDisabled} onClick={() => onConfirm(reason.trim())} data-testid="action-dialog-confirm">
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Shown in place of a page a platform role cannot use (the API refuses it as well). */
export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <div role="alert" className="rounded-card border border-line bg-surface-info px-4 py-3 text-sm text-ink-2" data-testid="platform-no-access">
      Your platform role does not include {what}.
    </div>
  );
}

/** Filter row: a two-column grid on phones (search full width), a wrapping row from tablet up. Never widens the page. */
export function PlatformFilters({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center [&>span]:min-w-0" data-testid="platform-filters">{children}</div>;
}

/** A label + value pair for detail pages. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

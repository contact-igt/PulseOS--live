import type { ReactNode } from "react";
import { PulseLockup } from "@pulseos/ui";
import type { TenantLoginBranding } from "@pulseos/types";

export function TenantBrandedLogin({ branding, children }: { branding: TenantLoginBranding; children: ReactNode }) {
  const { tagline, badgeLabel, supportText } = branding;
  return (
    <main className="app-shell flex min-h-screen flex-col lg:flex-row" data-testid="tenant-login" data-workspace={branding.slug}>
      <section className="app-login-visual relative overflow-hidden px-5 pb-14 pt-5 sm:px-10 sm:pb-16 sm:pt-8 lg:flex lg:w-[46%] lg:flex-col lg:justify-between lg:p-12" data-testid="login-visual">
        {/* Quiet connective rings echoing the mark's nodes: decoration only. */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.10]" viewBox="0 0 800 900" fill="none" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
          <circle cx="700" cy="140" r="200" stroke="white" strokeWidth="1" />
          <circle cx="700" cy="140" r="300" stroke="white" strokeWidth="1" />
          <circle cx="700" cy="140" r="400" stroke="white" strokeWidth="1" />
        </svg>

        <div className="relative flex min-w-0 items-center gap-3" data-testid="login-lockup">
          <PulseLockup tone="onBlue" size={34} showBeta={false} />
        </div>

        <div className="relative mt-8 max-w-md lg:mt-0">
          <p className="text-sm leading-relaxed text-primary-100 sm:text-[15px]" data-testid="login-tagline">{tagline}</p>
        </div>

        <p className="relative hidden text-xs text-primary-200 lg:block" data-testid="login-note">{badgeLabel ? `${badgeLabel} workspace` : ""}</p>
      </section>

      <div className="flex flex-1 items-start justify-center px-4 pb-10 sm:px-6 lg:items-center lg:py-10">
        <div className="relative -mt-8 w-full max-w-[400px] lg:mt-0">
          <div className="rounded-panel border border-line bg-white p-6 shadow-glass sm:p-8">
            <div className="flex items-center justify-between gap-3">
              <h1 className="text-xl font-semibold text-slate-900">Welcome back</h1>
              {badgeLabel && (
                <span className="rounded-chip border border-primary-200 bg-primary-50 px-2 py-0.5 text-[11px] font-medium text-primary-700" data-testid="tenant-login-pilot">{badgeLabel}</span>
              )}
            </div>
            {children}
          </div>
          <p className="mt-5 text-center text-xs text-neutral-600" data-testid="login-support">{supportText}</p>
        </div>
      </div>
    </main>
  );
}

/** What anyone sees at an address that is not a workspace: nothing about any hospital, and no way to find one. */
export function WorkspaceNotFound({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <main className="app-shell flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[400px] rounded-panel border border-line bg-white p-6 text-center shadow-glass sm:p-8" data-testid={unavailable ? "tenant-login-unavailable" : "tenant-login-missing"}>
        <PulseLockup tone="onWhite" size={30} showBeta={false} />
        <h1 className="mt-5 text-lg font-semibold text-slate-900">{unavailable ? "Sign-in is unavailable right now" : "Workspace not found"}</h1>
        <p className="mt-2 text-sm text-neutral-600">{unavailable ? "Please try again in a moment." : "Check the address you were given, or contact your administrator."}</p>
      </div>
    </main>
  );
}

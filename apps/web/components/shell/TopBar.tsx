"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown, LogOut, Menu, Search, Type } from "lucide-react";
import { QuickCreateMenu, JOURNEY_STAGE_LABEL, useExclusiveMenu, useFloatingMenu, type QuickCreateItem } from "@pulseos/ui";
import { roleGroupLabel, type SessionUser } from "@pulseos/types";
import { api, ApiError } from "@pulseos/api-client";
import { useQuickCreate } from "./QuickCreateProvider";
import { initials } from "./nav";
import { loginPathFor } from "@/lib/loginPage";
import { DisplaySettingsSheet } from "./DisplaySettingsSheet";

export function TopBar({
  user,
  title,
  subtitle,
  onMenuClick,
}: {
  user: SessionUser;
  title: string;
  subtitle?: string;
  onMenuClick?: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const { containerRef: profileRef, triggerRef: profileTriggerRef, onMenuKeyDown: onProfileKeyDown } = useFloatingMenu("profile", profileOpen, setProfileOpen);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const quickCreate = useQuickCreate();

  const quickCreateItems: QuickCreateItem[] = [
    user.role !== "DOCTOR" && { key: "lead", label: "Add Lead", onClick: () => quickCreate.openAddLead() },
    user.role !== "DOCTOR" && { key: "appointment", label: "Add Appointment", onClick: () => quickCreate.openNewAppointment() },
    user.role !== "DOCTOR" && { key: "task", label: "Add Task", onClick: () => quickCreate.openAddTask() },
    user.role !== "DOCTOR" && { key: "patient", label: "Add Patient", onClick: () => quickCreate.openAddPatient() },
  ].filter((x): x is QuickCreateItem => !!x);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
    } catch (err) {
      // An already-expired session is effectively logged out. Anything else
      // (network, 5xx) may have left the server session alive — say so rather
      // than pretending it worked.
      if (!(err instanceof ApiError && err.status === 401)) {
        setLogoutError("Couldn't log out. Check your connection and try again.");
        setLoggingOut(false);
        return;
      }
    }
    queryClient.clear();
    router.replace(loginPathFor(user.loginSlug));
  }

  return (
    <header className="glass-strong absolute inset-x-0 top-0 z-(--z-sticky) flex h-16 items-center justify-between gap-3 px-3 max-lg:rounded-none max-lg:border-x-0 max-lg:border-t-0 sm:gap-4 sm:px-5 lg:right-3 lg:top-3 lg:rounded-panel">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenuClick}
          className="-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-neutral-600 transition hover:bg-white/70 hover:text-slate-900 lg:hidden"
          title="Open menu"
          data-testid="mobile-menu-button"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-ink sm:text-base">{title}</h1>
          {/* Subtitle is secondary: hidden on small screens so the title is never squeezed to an ellipsis. */}
          {subtitle && <p className="hidden truncate text-xs text-ink-2 sm:block">{subtitle}</p>}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <div className="hidden sm:block">
          <GlobalPatientSearch />
        </div>

        <QuickCreateMenu items={quickCreateItems} />

        {/* Not wired to anything yet (no notifications domain exists) —
            visibly disabled rather than a silent no-op click. */}
        <button
          type="button"
          disabled
          className="glass-control hidden h-9 w-9 cursor-not-allowed items-center justify-center rounded-control text-neutral-400 sm:inline-flex"
          title="Notifications — coming soon"
          aria-label="Notifications — coming soon"
          data-testid="notifications-button"
        >
          <Bell size={16} />
        </button>

        <div className="relative" ref={profileRef}>
          <button
            ref={profileTriggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen((v) => !v)}
            className="glass-control flex h-9 items-center gap-1.5 rounded-control px-1.5 text-left transition hover:bg-white"
            data-testid="profile-menu-trigger"
          >
            {/* Narrow screens show initials: the full name wrapped to two lines and squeezed the page title. */}
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700 sm:hidden" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="hidden text-sm text-slate-900 sm:inline">{user.name}</span>
            <span className="sr-only sm:hidden">{user.name}</span>
            <ChevronDown size={14} className="text-neutral-400" />
          </button>
          {profileOpen && (
            <div className="floating absolute right-0 top-full z-(--z-dropdown) mt-1.5 w-52 rounded-card py-1" role="menu" aria-label="Account" onKeyDown={onProfileKeyDown} data-testid="profile-menu">
              <div className="border-b border-neutral-100 px-3 py-2">
                <p className="text-xs font-medium text-slate-900">{roleGroupLabel(user.role)}</p>
                {user.branchName && <p className="text-xs text-neutral-500">{user.branchName}</p>}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setProfileOpen(false);
                  setDisplayOpen(true);
                }}
                className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-600 transition hover:bg-primary-50 hover:text-ink focus-visible:bg-primary-50 lg:min-h-0"
                data-testid="display-settings-item"
              >
                <Type size={14} />
                Display settings
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={logout}
                disabled={loggingOut}
                aria-busy={loggingOut}
                className="flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-600 transition hover:bg-primary-50 hover:text-ink focus-visible:bg-primary-50 disabled:cursor-wait disabled:opacity-60 lg:min-h-0"
                data-testid="logout-button"
              >
                <LogOut size={14} />
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
              {logoutError && (
                <p role="alert" className="mx-2 mb-1.5 rounded-control bg-danger-100 px-2 py-1.5 text-[11px] text-danger-700" data-testid="logout-error">
                  {logoutError}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {displayOpen && <DisplaySettingsSheet onClose={() => setDisplayOpen(false)} />}
    </header>
  );
}

/** Wraps the first matching substring in a highlighted <mark> — case-insensitive, plain text otherwise. */
function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary-100 text-primary-900">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Real debounced typeahead over /patients/search (never the full patient
 * directory), 2-char trigger, arrow/Enter/Escape keyboard nav, selecting a
 * row opens Patient 360 directly.
 */
function GlobalPatientSearch() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const trimmed = debouncedQuery.trim();
  const results = useQuery({
    queryKey: ["global-patient-search", trimmed],
    queryFn: () => api.searchPatients(trimmed),
    enabled: trimmed.length >= 2,
  });

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const rows = results.data ?? [];
  const showDropdown = open && trimmed.length >= 2;
  // Opening the account or Create menu closes this list (and the other way round).
  useExclusiveMenu("search", showDropdown, () => setOpen(false));

  function selectRow(id: string) {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    router.push(`/patients/${id}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (!showDropdown || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? rows.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = activeIndex >= 0 ? rows[activeIndex] : rows[0];
      if (target) selectRow(target.id);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <div className="glass-control flex h-9 items-center gap-1.5 rounded-control px-2.5 transition focus-within:border-primary-400 focus-within:bg-white">
        <Search size={16} className="text-neutral-400" />
        <input
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls="global-patient-search-results"
          aria-autocomplete="list"
          placeholder="Search patients…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-40 bg-transparent text-xs text-slate-900 outline-none placeholder:text-neutral-400 lg:w-56"
          data-testid="global-patient-search"
        />
      </div>

      {showDropdown && (
        <ul
          id="global-patient-search-results"
          role="listbox"
          className="floating absolute right-0 top-full z-(--z-dropdown) mt-1.5 max-h-80 w-72 overflow-y-auto rounded-card py-1 sm:w-80"
          data-testid="global-patient-search-results"
        >
          {results.isFetching && rows.length === 0 && (
            <li className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-400">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-primary-500" aria-hidden="true" />
              Searching…
            </li>
          )}
          {!results.isFetching && rows.length === 0 && <li className="px-3 py-2 text-xs text-neutral-400">No patients found.</li>}
          {rows.map((row, i) => (
            <li key={row.id} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                onClick={() => selectRow(row.id)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left text-xs ${i === activeIndex ? "border-primary-500 bg-primary-50" : "border-transparent hover:bg-neutral-50"}`}
                data-testid={`global-search-result-${row.id}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900">{highlightMatch(row.name, trimmed)}</span>
                  <span className="block truncate text-[11px] text-neutral-400">{highlightMatch(row.phone, trimmed)}</span>
                </span>
                {row.currentJourneyType && (
                  <span className="shrink-0 text-right text-[11px] text-neutral-400">
                    <span className="block truncate">{row.currentJourneyType}</span>
                    {row.currentStage && <span className="block text-neutral-300">{JOURNEY_STAGE_LABEL[row.currentStage] ?? row.currentStage}</span>}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

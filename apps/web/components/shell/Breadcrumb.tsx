"use client";

import { Suspense, useEffect, useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { journeyCrumbs, listKeyForPath, patientCrumbs, recordListUrl, type Crumb, type CrumbStorage } from "./breadcrumbs";

/** Session storage when the browser allows it (it can throw or be absent), else null: crumbs then link to the plain lists. */
function browserStorage(): CrumbStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

const subscribeNever = () => () => undefined;
const serverStorage = (): CrumbStorage | null => null;

/** The shared breadcrumb trail. The last crumb is the page you are on (no link, aria-current). Long names truncate, never wrap the page wide. */
export function Breadcrumb({ crumbs, testId = "breadcrumb" }: { crumbs: Crumb[]; testId?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1 min-w-0" data-testid={testId}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-ink-2">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${c.label}-${i}`} className={`flex min-w-0 items-center gap-1 ${last ? "text-ink" : ""}`}>
              {i > 0 && <ChevronRight size={12} className="shrink-0 text-neutral-400" aria-hidden="true" />}
              {c.href && !last ? (
                <Link href={c.href} className="inline-flex min-h-6 max-w-[14rem] items-center truncate font-medium text-primary-700 hover:underline max-md:min-h-11" data-testid={`${testId}-${i}`}>
                  {c.label}
                </Link>
              ) : (
                <span className="max-w-[16rem] truncate font-semibold" aria-current={last ? "page" : undefined} data-testid={`${testId}-${i}`}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Where this detail page was reached from, and the list URL (filters, page) that list was last at in this tab. */
function useCrumbSource() {
  const from = useSearchParams().get("from");
  // The server (and the first client render) has no storage, so the root links to the plain list; the browser then reads it. No effect, no mismatch.
  const storage = useSyncExternalStore(subscribeNever, browserStorage, serverStorage);
  return { from, storage };
}

/** Leads > Patient > Cataract - for the Journey page. */
export function JourneyBreadcrumb({ patient, journey }: { patient: { id: string; name: string }; journey: { id: string; journeyType: string } }) {
  const { from, storage } = useCrumbSource();
  const crumbs = useMemo(() => journeyCrumbs({ from, patient, journey, storage }), [from, patient, journey, storage]);
  return <Breadcrumb crumbs={crumbs} />;
}

/** Patients > Patient - for Patient 360. */
export function PatientBreadcrumb({ patient }: { patient: { id: string; name: string } }) {
  const { from, storage } = useCrumbSource();
  const crumbs = useMemo(() => patientCrumbs({ from, patient, storage }), [from, patient, storage]);
  return <Breadcrumb crumbs={crumbs} />;
}

function Recorder() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  useEffect(() => {
    const key = listKeyForPath(pathname);
    if (key) recordListUrl(browserStorage(), key, query ? `${pathname}?${query}` : pathname);
  }, [pathname, query]);
  return null;
}

/** Remembers each list page's URL (its filters and page) for this tab, so a breadcrumb back to the list lands where you were. */
export function ListContextRecorder() {
  return (
    <Suspense fallback={null}>
      <Recorder />
    </Suspense>
  );
}

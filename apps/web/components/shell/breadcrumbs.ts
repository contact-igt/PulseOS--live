// Domain-aware breadcrumbs. A breadcrumb says where you are in the PulseOS domain, not in the URL:
//   Leads > Patient > Cataract        (a Journey, reached from the Leads list)
//   Patients > Patient                (Patient 360)
// The ROOT is the list you came from (the `?from=` key every list page already puts on its detail links). The Patient and
// the Journey are different things: the Patient is a person, the Journey is one enquiry ("Cataract") - so the Patient is a
// link and the Journey is the page. Nothing here ever says "Customer".
//
// List context (filters, page) is URL state: each list page's own URL is remembered per tab (see ListContextRecorder), and
// the root crumb links back to exactly that URL. Only a URL that is that list's own path is ever stored or returned.

export type Crumb = { label: string; href?: string };

/** Minimal Storage surface, so tests and server renders can pass nothing or a stub. */
export interface CrumbStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Every list a detail page can be reached from: its crumb label and the path that list lives at. */
const ROOTS: Record<string, { label: string; href: string }> = {
  leads: { label: "Leads", href: "/leads" },
  patients: { label: "Patients", href: "/patients" },
  journeys: { label: "Journeys", href: "/journeys" },
  treatments: { label: "Treatments", href: "/treatments" },
  appointments: { label: "Appointments", href: "/appointments" },
  "command-centre": { label: "Command Centre", href: "/command-centre" },
  inbox: { label: "Inbox", href: "/inbox" },
  "my-work": { label: "My Work", href: "/my-work" },
  "doctor-home": { label: "Command Centre", href: "/doctor-home" },
  campaigns: { label: "Campaigns / Sources", href: "/campaigns" },
  settings: { label: "Settings", href: "/settings" },
};

const STORAGE_PREFIX = "pulseos.list.";
const MAX_URL = 2000;

/** The list keys whose URL is worth remembering (pages with filters / paging). */
export const LIST_KEYS = Object.keys(ROOTS);

/** The list key a pathname is the root of (`/leads` -> `leads`), or null for any other path. */
export function listKeyForPath(pathname: string): string | null {
  return LIST_KEYS.find((k) => ROOTS[k]!.href === pathname) ?? null;
}

/** True only for the list's own path with an optional query: never another path, origin, protocol-relative link or oversized value. */
function isOwnListUrl(key: string, url: string): boolean {
  if (!Object.hasOwn(ROOTS, key) || url.length > MAX_URL) return false;
  const path = ROOTS[key]!.href;
  if (url !== path && !url.startsWith(`${path}?`)) return false;
  return !/[\\\s]/.test(url) && !url.includes("..") && !url.includes("//");
}

export function recordListUrl(storage: CrumbStorage | null | undefined, key: string, url: string): void {
  if (!storage || !isOwnListUrl(key, url)) return;
  try {
    storage.setItem(STORAGE_PREFIX + key, url);
  } catch {
    // Storage blocked (private window, quota): the breadcrumb simply links to the plain list.
  }
}

export function readListUrl(storage: CrumbStorage | null | undefined, key: string): string | null {
  if (!storage || !Object.hasOwn(ROOTS, key)) return null;
  try {
    const value = storage.getItem(STORAGE_PREFIX + key);
    return value && isOwnListUrl(key, value) ? value : null;
  } catch {
    return null;
  }
}

/** The root crumb for a `?from=` key: the list's label, linked to the URL it was last at (filters and page kept). */
export function rootCrumb(from: string | null | undefined, fallback: { label: string; href: string }, storage?: CrumbStorage | null): { label: string; href: string } {
  if (!from || !Object.hasOwn(ROOTS, from)) return fallback;
  const root = ROOTS[from]!;
  return { label: root.label, href: readListUrl(storage, from) ?? root.href };
}

const withFromKey = (href: string, from: string | null | undefined) => (from && Object.hasOwn(ROOTS, from) ? `${href}?from=${from}` : href);

/** Leads > Patient > Cataract. The root is where the person came from; the Patient carries it forward; the Journey is the page. */
export function journeyCrumbs(i: { from: string | null | undefined; patient: { id: string; name: string }; journey: { id: string; journeyType: string }; storage?: CrumbStorage | null }): Crumb[] {
  const root = rootCrumb(i.from, ROOTS.journeys!, i.storage);
  return [root, { label: i.patient.name || "Patient", href: withFromKey(`/patients/${i.patient.id}`, i.from) }, { label: i.journey.journeyType || "Journey" }];
}

/** Patients > Patient. */
export function patientCrumbs(i: { from: string | null | undefined; patient: { id: string; name: string }; storage?: CrumbStorage | null }): Crumb[] {
  return [rootCrumb(i.from, ROOTS.patients!, i.storage), { label: i.patient.name || "Patient" }];
}

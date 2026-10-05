/**
 * The one writer for view / date / filter state kept in the URL.
 *
 * It patches the LIVE address bar (`window.location`), not a snapshot captured
 * at render, and writes with `history.replaceState` — which Next's App Router
 * syncs straight into `useSearchParams`, with no server round trip. So:
 *  - the UI reacts on the same frame (a pill, tab or search box never lags);
 *  - two writers in quick succession (or in one handler) build on each other
 *    instead of one overwriting the other with a stale snapshot;
 *  - typing in a search box is not a server navigation per keystroke;
 *  - it adds no history entry, so Back still leaves the page.
 * Reload and shared links restore the state; Back/Forward across pages restore
 * whatever each page's URL held.
 *
 * `undefined` or `""` deletes a param. Anything else in the query string (and
 * the hash) is left exactly as it was. Returns the resulting query string.
 */
export function replaceUrlParams(patch: Record<string, string | undefined>): string {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, "", next);
  }
  return url.search.replace(/^\?/, "");
}

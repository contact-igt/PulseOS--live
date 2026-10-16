// WEB_ORIGIN may hold several web addresses, comma-separated (e.g. the Railway address and the custom domain). Each is reduced to a
// bare origin (scheme + host + non-default port) so "https://App.example.com/" and "https://app.example.com" are the same entry.
// Matching is exact string equality on that normalised origin: never a prefix, suffix or wildcard.

const DEFAULT_ORIGIN = "http://localhost:3000";

export function parseWebOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").replace(/^\s*["']|["']\s*$/g, "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  return out.length ? out : [DEFAULT_ORIGIN];
}

/** The configured origin equal to the request's Origin header, or null. */
export function matchWebOrigin(allowed: readonly string[], origin: string | undefined): string | null {
  return origin !== undefined && allowed.includes(origin) ? origin : null;
}

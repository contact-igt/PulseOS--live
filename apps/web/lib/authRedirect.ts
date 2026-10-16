// Return-to-page for sign-in. A signed-out person who opens /patients/abc is sent to sign in and, once in, brought back to
// /patients/abc (the same behaviour WhatsNexus has with its `?from=`), but the session itself stays an httpOnly cookie: nothing
// here reads or stores a token. The value is untrusted input from the address bar, so only a plain in-app path is ever followed;
// anything that could leave the app, or land on a public page, is dropped.

const PUBLIC_PATHS = /^\/(login|signup)(\/|\?|$)/;

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) return null;
  if (raw === "/" || PUBLIC_PATHS.test(raw)) return null;
  return raw;
}

/** `/login` (or `/login/<slug>`) carrying the page the person was on, when there is a sensible one. */
export function loginHrefWithReturn(loginPath: string, from: string | null | undefined): string {
  const safe = safeReturnPath(from);
  return safe ? `${loginPath}?from=${encodeURIComponent(safe)}` : loginPath;
}

/** Where to go after signing in: the requested page when this role may use it, else the role's own home. */
export function afterLoginPath(from: string | null | undefined, roleHome: string, allowed: (path: string) => boolean): string {
  const safe = safeReturnPath(from);
  return safe && allowed(safe.split("?")[0]!) ? safe : roleHome;
}

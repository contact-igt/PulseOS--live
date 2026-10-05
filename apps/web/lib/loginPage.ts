// Where a signed-out person goes: a hospital with its own sign-in page (/login/<slug>) sends its people back to THAT page, not to
// the general one. The slug comes from the session, and is remembered so an expired session still lands in the right place.
// Only a well-formed slug is ever followed, so a tampered value cannot send anyone anywhere but /login/<word>.

const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const KEY = "pulseos.loginPage";

export function loginPathFor(slug: string | null | undefined): string {
  return slug && SLUG.test(slug) ? `/login/${slug}` : "/login";
}

export function rememberLoginPage(slug: string | null | undefined): void {
  try {
    if (slug && SLUG.test(slug)) window.localStorage.setItem(KEY, slug);
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the general sign-in page is the fallback.
  }
}

export function rememberedLoginPath(): string {
  try {
    return loginPathFor(window.localStorage.getItem(KEY));
  } catch {
    return "/login";
  }
}

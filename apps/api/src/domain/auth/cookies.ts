/** The one set of rules for every session cookie this API sets (tenant, platform, support): httpOnly, COOKIE_SAMESITE, secure when it must be. */
export function sessionCookieBase() {
  const sameSite = (process.env.COOKIE_SAMESITE as "lax" | "strict" | "none") ?? "lax";
  const secure = process.env.NODE_ENV === "production" || sameSite === "none";
  return { httpOnly: true, sameSite, secure, path: "/" } as const;
}

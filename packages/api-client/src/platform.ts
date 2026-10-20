import type { Paged, PlatformOverview, PlatformSessionUser } from "@pulseos/types";
import { apiRequest as request } from "./index";

/** Query string from defined, non-empty values only. */
function qs(params: object): string {
  const entries = (Object.entries(params) as [string, unknown][]).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : "";
}
const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * The Platform Console API (company side). Separate cookie, separate identity: a tenant session gets 401 from every call.
 * Nothing here ever returns a password, a token, a credential or ciphertext.
 */
export const platformApi = {
  login: (email: string, password: string) => request<{ user: PlatformSessionUser }>("/platform/auth/login", json("POST", { email, password })),
  logout: () => request<{ ok: true }>("/platform/auth/logout", { method: "POST" }),
  session: () => request<{ user: PlatformSessionUser }>("/platform/auth/session"),
  overview: () => request<PlatformOverview>("/platform/overview"),
};

export { qs as platformQuery, json as platformJson };
export type { Paged };

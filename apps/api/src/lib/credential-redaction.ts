// Credential-shaped parameter names a provider (or an operator, in a webhook URL) may use to carry a key. Compared
// case-insensitively with separators ignored, so api_key, apiKey and API-KEY are the same name.
const SENSITIVE = new Set(["apikey", "key", "secret", "secretkey", "integrationkey", "token", "accesstoken", "authorization", "password", "signature"]);
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
export const isCredentialName = (name: string): boolean => SENSITIVE.has(normalize(name));

/** A copy of the payload without credential-named top-level fields. Used once authentication has passed. */
export function withoutCredentials<T extends Record<string, unknown>>(payload: T): Partial<T> {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !isCredentialName(k))) as Partial<T>;
}

/**
 * The request URL as it may be logged. Credential-valued query parameters are always replaced. On a provider WEBHOOK path every
 * value is replaced (names stay): a provider that delivers by GET puts the call itself, including the caller's number, in the query.
 */
export function redactUrlSecrets(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const everyValue = url.slice(0, q).startsWith("/webhooks/");
  const params = new URLSearchParams(url.slice(q + 1));
  for (const name of [...new Set([...params.keys()])]) if (everyValue || isCredentialName(name)) params.set(name, "[redacted]");
  return `${url.slice(0, q)}?${params.toString().replace(/%5Bredacted%5D/g, "[redacted]")}`;
}

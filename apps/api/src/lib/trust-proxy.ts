/**
 * Fastify `trustProxy` from TRUST_PROXY. Unset / "false" = trust nobody (request.ip is the socket peer). A number is
 * the count of proxy hops in front of the API (1 = one reverse proxy: the client is the address it appended). A
 * comma-separated list of IPs/CIDRs names the proxies to trust. "true" means ONE hop — never "trust every hop",
 * which would let any client choose its own address via X-Forwarded-For.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string[] {
  const v = value?.trim();
  if (!v || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

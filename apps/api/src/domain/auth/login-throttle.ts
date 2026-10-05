import { createHash } from "node:crypto";

// A small in-memory throttle for sign-in attempts. Not an anti-fraud platform: it stops a script from guessing
// passwords against one account (or spraying many accounts from one address) at wire speed.
//   - per account + address: MAX_PER_ACCOUNT attempts inside the window locks that pair until the window ends;
//   - per address: MAX_PER_ADDRESS attempts (across any emails) locks the address, so rotating emails does not help.
// An attempt is RESERVED the moment it is admitted (before the slow password check), so a burst of parallel guesses
// cannot all slip under the limit; a correct sign-in releases its reservation and clears that pair. Blocked attempts
// are not counted. Keys are SHA-256 digests — no email or address is held in the clear. IPv6 clients are keyed by
// their /64 (one household / site, not one address), and IPv4-mapped addresses are unwrapped.
// State is per API process: behind several instances each enforces its own limit (a shared store is the upgrade path).

export interface LoginThrottleOptions {
  maxPerAccount?: number;
  maxPerAddress?: number;
  windowMs?: number;
  /** Hard cap on tracked keys, so a flood of random emails cannot grow memory without bound. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry {
  count: number;
  windowStart: number;
  /** The count at which this key locks. */
  limit: number;
}

export interface ThrottleDecision {
  /** False = locked: do not even look at the password. */
  allowed: boolean;
  retryAfterSeconds: number;
}

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

function expandIpv6(v: string): string[] | null {
  const bare = v.split("%")[0]!;
  if (bare.includes(".")) return null; // an embedded IPv4 tail: keep as is
  const [head, tail, ...rest] = bare.split("::");
  if (rest.length) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  if (tail === undefined && left.length !== 8) return null;
  const fill = tail === undefined ? [] : Array(Math.max(8 - left.length - right.length, 0)).fill("0");
  const groups = [...left, ...fill, ...right].map((g) => g.padStart(4, "0"));
  return groups.length === 8 ? groups : null;
}

/** What identifies a client for throttling: the IPv4 address, or the IPv6 /64 prefix. */
export function throttleAddress(ip: string): string {
  const v = ip.trim().toLowerCase();
  const mapped = /^(?:::ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1]!;
  if (v.includes(":")) {
    const groups = expandIpv6(v);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : v;
  }
  return v;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxPerAccount: number;
  private readonly maxPerAddress: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: LoginThrottleOptions = {}) {
    this.maxPerAccount = opts.maxPerAccount ?? 5;
    this.maxPerAddress = opts.maxPerAddress ?? 50;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private keys(address: string, email: string) {
    const addr = throttleAddress(address);
    return { account: `a:${digest(`${addr}|${email.trim().toLowerCase()}`)}`, address: `i:${digest(addr)}` };
  }

  private live(key: string): Entry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.windowStart >= this.windowMs) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  /**
   * Admit (and count) one sign-in attempt, or refuse it. Synchronous on purpose: the decision and the reservation happen
   * in one step, before any await, so concurrent attempts are counted exactly.
   */
  begin(address: string, email: string): ThrottleDecision {
    const { account, address: addr } = this.keys(address, email);
    const a = this.live(account);
    const i = this.live(addr);
    let wait = 0;
    for (const e of [a, i]) if (e && e.count >= e.limit) wait = Math.max(wait, e.windowStart + this.windowMs - this.now());
    if (wait > 0) return { allowed: false, retryAfterSeconds: Math.max(Math.ceil(wait / 1000), 1) };
    for (const [key, entry, limit] of [[account, a, this.maxPerAccount], [addr, i, this.maxPerAddress]] as const) {
      if (entry) entry.count += 1;
      else this.entries.set(key, { count: 1, windowStart: this.now(), limit });
    }
    if (this.entries.size > this.maxEntries) this.evict();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** A correct sign-in: clears that account+address pair and gives back its reservation on the address counter. */
  succeed(address: string, email: string): void {
    const { account, address: addr } = this.keys(address, email);
    this.entries.delete(account);
    const i = this.live(addr);
    if (i) {
      i.count -= 1;
      if (i.count <= 0) this.entries.delete(addr);
    }
  }

  private evict() {
    const now = this.now();
    for (const [key, e] of this.entries) if (now - e.windowStart >= this.windowMs) this.entries.delete(key);
    // Still over (a flood inside one window): drop down to 90% so this scan is not repeated every attempt — unlocked
    // entries first (oldest first), so active lockouts survive as long as possible.
    const target = Math.floor(this.maxEntries * 0.9);
    for (const locked of [false, true]) {
      for (const [key, e] of this.entries) {
        if (this.entries.size <= target) return;
        if ((e.count >= e.limit) === locked) this.entries.delete(key);
      }
    }
  }
}

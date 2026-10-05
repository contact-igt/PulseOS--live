import { describe, expect, it } from "vitest";
import { LoginThrottle, throttleAddress } from "../login-throttle.js";
import { parseTrustProxy } from "../../../lib/trust-proxy.js";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

/** One attempt as the route makes it: admitted (and counted) up front. */
const attempt = (th: LoginThrottle, ip: string, email: string) => th.begin(ip, email).allowed;

describe("LoginThrottle", () => {
  it("admits a few attempts, then locks that account+address with a retry time", () => {
    const c = clock();
    const th = new LoginThrottle({ now: c.now, maxPerAccount: 3, windowMs: 60_000 });
    expect([1, 2, 3].map(() => attempt(th, "1.1.1.1", "a@x.com"))).toEqual([true, true, true]);
    const d = th.begin("1.1.1.1", "a@x.com");
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("counts parallel attempts exactly: a burst admitted before any password is checked cannot exceed the limit", () => {
    const th = new LoginThrottle({ maxPerAccount: 5 });
    // The route reserves synchronously, before its first await — so 40 'concurrent' guesses are decided one by one.
    const results = Array.from({ length: 40 }, () => th.begin("1.1.1.1", "victim@x.com").allowed);
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it("blocked attempts are not counted (the lock does not extend itself)", () => {
    const c = clock();
    const th = new LoginThrottle({ now: c.now, maxPerAccount: 2, windowMs: 60_000 });
    attempt(th, "1.1.1.1", "a@x.com");
    attempt(th, "1.1.1.1", "a@x.com");
    for (let i = 0; i < 100; i++) expect(attempt(th, "1.1.1.1", "a@x.com")).toBe(false);
    c.advance(60_001);
    expect(attempt(th, "1.1.1.1", "a@x.com")).toBe(true);
  });

  it("is per account AND address: another address, or another account, is unaffected", () => {
    const th = new LoginThrottle({ maxPerAccount: 2 });
    attempt(th, "1.1.1.1", "a@x.com");
    attempt(th, "1.1.1.1", "a@x.com");
    expect(attempt(th, "1.1.1.1", "a@x.com")).toBe(false);
    expect(attempt(th, "2.2.2.2", "a@x.com")).toBe(true);
    expect(attempt(th, "1.1.1.1", "b@x.com")).toBe(true);
  });

  it("the email is normalised (case and spaces do not dodge the limit)", () => {
    const th = new LoginThrottle({ maxPerAccount: 2 });
    attempt(th, "1.1.1.1", "Mixed@X.com ");
    attempt(th, "1.1.1.1", " mixed@x.COM");
    expect(attempt(th, "1.1.1.1", "mixed@x.com")).toBe(false);
  });

  it("spraying many accounts from one address trips the address limit", () => {
    const th = new LoginThrottle({ maxPerAccount: 5, maxPerAddress: 4 });
    for (let i = 0; i < 4; i++) attempt(th, "9.9.9.9", `u${i}@x.com`);
    expect(attempt(th, "9.9.9.9", "fresh@x.com")).toBe(false);
    expect(attempt(th, "8.8.8.8", "fresh@x.com")).toBe(true);
  });

  it("a success clears the pair and returns its own reservation: only the typos count toward the shared address", () => {
    const th = new LoginThrottle({ maxPerAccount: 3, maxPerAddress: 50 });
    // 20 staff behind one NAT each mistype once and then sign in correctly: 20 typos, not 40 attempts, on the address.
    for (let i = 0; i < 20; i++) {
      expect(attempt(th, "10.0.0.1", `staff${i}@x.com`)).toBe(true); // a typo…
      expect(attempt(th, "10.0.0.1", `staff${i}@x.com`)).toBe(true); // …then the right password
      th.succeed("10.0.0.1", `staff${i}@x.com`);
    }
    expect(attempt(th, "10.0.0.1", "someone.else@x.com")).toBe(true); // the shared address is not locked
    // …whereas 50 failures from that address do lock it.
    for (let i = 0; i < 30; i++) attempt(th, "10.0.0.1", `guess${i}@x.com`);
    expect(attempt(th, "10.0.0.1", "someone.else@x.com")).toBe(false);
  });

  it("the lock ends by itself when the window passes", () => {
    const c = clock();
    const th = new LoginThrottle({ now: c.now, maxPerAccount: 2, windowMs: 60_000 });
    attempt(th, "1.1.1.1", "a@x.com");
    attempt(th, "1.1.1.1", "a@x.com");
    expect(attempt(th, "1.1.1.1", "a@x.com")).toBe(false);
    c.advance(60_001);
    expect(attempt(th, "1.1.1.1", "a@x.com")).toBe(true);
  });

  it("memory is bounded and a flood cannot evict an active lock before the unlocked entries", () => {
    const th = new LoginThrottle({ maxEntries: 50, maxPerAccount: 2 });
    attempt(th, "7.7.7.7", "victim@x.com");
    attempt(th, "7.7.7.7", "victim@x.com"); // locked
    for (let i = 0; i < 500; i++) attempt(th, `3.3.${i % 200}.${i % 250}`, `flood${i}@x.com`);
    expect((th as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(50);
    expect(attempt(th, "7.7.7.7", "victim@x.com")).toBe(false); // the lock survived the flood
  });

  it("keeps no email or address in the clear", () => {
    const th = new LoginThrottle();
    attempt(th, "203.0.113.9", "secret.person@hospital.org");
    const keys = [...(th as unknown as { entries: Map<string, unknown> }).entries.keys()].join(" ");
    expect(keys).not.toContain("secret");
    expect(keys).not.toContain("203.0.113");
  });
});

describe("throttle address", () => {
  it("IPv6 clients are one client per /64, however they rotate the low bits", () => {
    expect(throttleAddress("2001:db8:abcd:12::1")).toBe(throttleAddress("2001:db8:abcd:12:ffff:ffff:ffff:ffff"));
    expect(throttleAddress("2001:db8:abcd:12::1")).not.toBe(throttleAddress("2001:db8:abcd:13::1"));
    const th = new LoginThrottle({ maxPerAccount: 2 });
    th.begin("2001:db8:abcd:12::1", "a@x.com");
    th.begin("2001:db8:abcd:12::2", "a@x.com");
    expect(th.begin("2001:db8:abcd:12::3", "a@x.com").allowed).toBe(false);
  });

  it("an IPv4-mapped IPv6 address is the same client as the IPv4 address", () => {
    expect(throttleAddress("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(throttleAddress("198.51.100.7")).toBe("198.51.100.7");
  });
});

describe("TRUST_PROXY", () => {
  it("trusts nobody by default, a number of hops, or named proxies — never 'every hop'", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(1); // one hop, not unlimited trust in X-Forwarded-For
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("10.0.0.0/8, 192.168.1.5")).toEqual(["10.0.0.0/8", "192.168.1.5"]);
  });
});

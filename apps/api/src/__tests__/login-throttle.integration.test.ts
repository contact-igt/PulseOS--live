import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("sign-in throttle (integration)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  const login = (email: string, password: string, ip: string) => app.inject({ method: "POST", url: "/auth/login", payload: { email, password }, remoteAddress: ip });

  it("repeated wrong passwords end in a generic 429 with Retry-After; the right password is not even tried while locked", async () => {
    const ip = "198.51.100.10";
    for (let i = 0; i < 5; i++) expect((await login("eye.admin@pulseos.local", "wrong-password", ip)).statusCode).toBe(401);
    const locked = await login("eye.admin@pulseos.local", "wrong-password", ip);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: "too_many_attempts", message: "Too many sign-in attempts. Please wait a few minutes and try again." });
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await login("eye.admin@pulseos.local", DEMO_PASSWORD!, ip)).statusCode).toBe(429); // no oracle: correct or not, same answer
  });

  it("an unknown email is throttled and answered exactly like a known one (nothing reveals whether the account exists)", async () => {
    const ip = "198.51.100.11";
    const known = await login("eye.doctor@pulseos.local", "nope", ip);
    const unknown = await login("nobody.such@pulseos.local", "nope", ip);
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    for (let i = 0; i < 4; i++) await login("nobody.such@pulseos.local", "nope", ip);
    const locked = await login("nobody.such@pulseos.local", "nope", ip);
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual((await (async () => { for (let i = 0; i < 5; i++) await login("eye.coordinator@pulseos.local", "nope", "198.51.100.12"); return login("eye.coordinator@pulseos.local", "nope", "198.51.100.12"); })()).json());
  });

  it("another address and another account are unaffected, and a success is never blocked by old failures", async () => {
    const ip = "198.51.100.13";
    for (let i = 0; i < 3; i++) await login("eye.frontdesk@pulseos.local", "typo", ip);
    expect((await login("eye.frontdesk@pulseos.local", DEMO_PASSWORD!, ip)).statusCode).toBe(200); // under the limit: signs in
    for (let i = 0; i < 4; i++) await login("eye.frontdesk@pulseos.local", "typo", ip); // the success cleared the count: 4 more is still fine
    expect((await login("eye.frontdesk@pulseos.local", DEMO_PASSWORD!, ip)).statusCode).toBe(200);
    expect((await login("eye.admin@pulseos.local", DEMO_PASSWORD!, "198.51.100.14")).statusCode).toBe(200); // other address, locked account elsewhere
    expect((await login("eye.superadmin@pulseos.local", DEMO_PASSWORD!, "198.51.100.10")).statusCode).toBe(200); // other account on a locked address pair
  });

  it("a malformed body is a 400 and does not count as a failed attempt", async () => {
    const ip = "198.51.100.15";
    for (let i = 0; i < 8; i++) expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: "not-an-email" }, remoteAddress: ip })).statusCode).toBe(400);
    expect((await login("eye.admin@pulseos.local", DEMO_PASSWORD!, ip)).statusCode).toBe(200);
  });

  it("a burst of parallel guesses is counted exactly: at most five reach the password check, the rest are refused", async () => {
    const ip = "198.51.100.20";
    const results = await Promise.all(Array.from({ length: 25 }, () => login("eye.admin@pulseos.local", "guess", ip)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(20);
  });

  it("an IPv6 client rotating its low bits is still one client", async () => {
    const results: number[] = [];
    for (let i = 1; i <= 7; i++) results.push((await login("eye.doctor@pulseos.local", "guess", `2001:db8:77:aa::${i}`)).statusCode);
    expect(results).toEqual([401, 401, 401, 401, 401, 429, 429]);
  });
});

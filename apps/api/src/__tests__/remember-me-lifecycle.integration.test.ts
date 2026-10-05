import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";

// "Remember me" is owned by the server: checked = a 7-day session row and a persistent httpOnly cookie that expires with
// it; unchecked = the standard 12-hour session row and a browser-session cookie. Logout invalidates either. The session
// id is never in a response body (so page JavaScript cannot read it).

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const EMAIL = "eye.frontdesk@pulseos.local";
const DAY_MS = 86_400_000;

describe.skipIf(!DEMO_PASSWORD)("Remember me lifecycle (integration)", () => {
  let app: FastifyInstance;
  const login = (remember?: boolean) => app.inject({ method: "POST", url: "/auth/login", payload: { email: EMAIL, password: DEMO_PASSWORD, ...(remember === undefined ? {} : { remember }) } });
  // The shared driver hands timestamps back as strings, so build the Date here.
  const expiry = async (id: string) => {
    const row = (await queryClient`select expires_at from sessions where id = ${id}`)[0];
    return row ? new Date(row.expires_at as string | Date) : undefined;
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("checked: the session lives 7 days on the server and the cookie is persistent, httpOnly and expires with it", async () => {
    const before = Date.now();
    const res = await login(true);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "pulseos_session")!;
    const serverExpiry = (await expiry(cookie.value))!.getTime();
    expect(Math.abs(serverExpiry - (before + 7 * DAY_MS))).toBeLessThan(60_000);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.expires, "a persistent cookie").toBeInstanceOf(Date);
    expect(Math.abs(cookie.expires!.getTime() - serverExpiry)).toBeLessThan(2_000);
    expect(res.body).not.toContain(cookie.value);
    await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie.value } });
  });

  it("unchecked (or omitted): the standard 12-hour session and a cookie that ends with the browser session", async () => {
    for (const remember of [false, undefined]) {
      const before = Date.now();
      const res = await login(remember);
      const cookie = res.cookies.find((c) => c.name === "pulseos_session")!;
      const serverExpiry = (await expiry(cookie.value))!.getTime();
      expect(Math.abs(serverExpiry - (before + 0.5 * DAY_MS))).toBeLessThan(60_000);
      expect(cookie.expires, "a session cookie has no expiry").toBeUndefined();
      await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: cookie.value } });
    }
  });

  it("logout deletes the server session (so the 7-day cookie is dead at once) and clears the cookie", async () => {
    const res = await login(true);
    const id = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    expect(await expiry(id)).toBeTruthy();
    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies: { pulseos_session: id } });
    expect(out.statusCode).toBe(200);
    expect(await expiry(id)).toBeUndefined();
    const after = await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: id } });
    expect(after.statusCode).toBe(401);
  });

  it("an expired 7-day session is refused", async () => {
    const res = await login(true);
    const id = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    await queryClient`update sessions set expires_at = now() - interval '1 minute' where id = ${id}`;
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: id } })).statusCode).toBe(401);
    await queryClient`delete from sessions where id = ${id}`;
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, apiRequest, ApiError } from "../index";

type FetchArgs = [string, RequestInit];

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("api-client request()", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respond(status: number, body: string | null, contentType = "application/json") {
    fetchMock.mockResolvedValueOnce(new Response(body, { status, headers: body === null ? {} : { "content-type": contentType } }));
  }

  it("sends a bodyless POST (logout) WITHOUT a JSON content-type — Fastify rejects an empty JSON body with 400", async () => {
    respond(200, JSON.stringify({ ok: true }));
    await api.logout();
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(headerOf(init, "content-type")).toBeNull();
    expect(init.credentials).toBe("include");
  });

  it("sends a JSON body with application/json", async () => {
    respond(200, JSON.stringify({ user: { id: "u1" } }));
    await api.login("a@b.test", "pw");
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(headerOf(init, "content-type")).toBe("application/json");
    // Remember Me is server-owned: the client always states the choice, defaulting to the shorter session.
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.test", password: "pw", remember: false });
  });

  it("preserves a caller-provided content-type", async () => {
    respond(200, JSON.stringify({ ok: true }));
    await apiRequest("/x", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(headerOf(init, "content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("never sets a content-type for FormData (the browser adds the multipart boundary)", async () => {
    respond(200, JSON.stringify({ ok: true }));
    const form = new FormData();
    form.append("file", "x");
    await apiRequest("/upload", { method: "POST", body: form });
    const [, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(headerOf(init, "content-type")).toBeNull();
  });

  it("resolves a 204 No Content success without trying to parse JSON", async () => {
    respond(204, null);
    await expect(apiRequest("/x", { method: "POST" })).resolves.toBeUndefined();
  });

  it("resolves a 200 with an empty body without throwing", async () => {
    respond(200, "");
    await expect(apiRequest("/x", { method: "POST" })).resolves.toBeUndefined();
  });

  it("still parses typed JSON on a normal success", async () => {
    respond(200, JSON.stringify({ ok: true }));
    await expect(apiRequest<{ ok: boolean }>("/x")).resolves.toEqual({ ok: true });
  });

  it("throws an ApiError carrying status and the API's error code", async () => {
    respond(401, JSON.stringify({ error: "invalid_credentials" }));
    const err = await apiRequest("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe("invalid_credentials");
  });

  it("throws an ApiError (not a JSON parse error) when an error response has no JSON body", async () => {
    respond(502, "<html>bad gateway</html>", "text/html");
    const err = await apiRequest("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });
});

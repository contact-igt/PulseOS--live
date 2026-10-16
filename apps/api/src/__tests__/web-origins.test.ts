import { describe, expect, it } from "vitest";
import { matchWebOrigin, parseWebOrigins } from "../lib/web-origins.js";

describe("parseWebOrigins", () => {
  it("reads a comma-separated list, trimming spaces", () => {
    expect(parseWebOrigins("https://a.up.railway.app , https://pulseos.invictusglobaltech.com")).toEqual(["https://a.up.railway.app", "https://pulseos.invictusglobaltech.com"]);
  });
  it("normalises each entry: trailing slash, path, case and default port are dropped", () => {
    expect(parseWebOrigins("HTTPS://Pulseos.Example.com/, https://b.example.com:443/app?x=1, http://localhost:3310/")).toEqual(["https://pulseos.example.com", "https://b.example.com", "http://localhost:3310"]);
  });
  it("keeps a non-default port and removes duplicates, in order", () => {
    expect(parseWebOrigins("http://localhost:3310,http://localhost:3310/,https://x.example")).toEqual(["http://localhost:3310", "https://x.example"]);
  });
  it("ignores blanks, quotes around the whole value, and entries that are not http(s) origins", () => {
    expect(parseWebOrigins(' "https://a.example, ,not a url,javascript:alert(1),ftp://x.example" ')).toEqual(["https://a.example"]);
  });
  it("falls back to the local default when nothing usable is configured", () => {
    expect(parseWebOrigins(undefined)).toEqual(["http://localhost:3000"]);
    expect(parseWebOrigins("")).toEqual(["http://localhost:3000"]);
    expect(parseWebOrigins(" , nonsense ")).toEqual(["http://localhost:3000"]);
  });
});

describe("matchWebOrigin", () => {
  const list = ["https://a.example", "http://localhost:3310"];
  it("matches only an exact configured origin", () => {
    expect(matchWebOrigin(list, "https://a.example")).toBe("https://a.example");
    expect(matchWebOrigin(list, "http://localhost:3310")).toBe("http://localhost:3310");
  });
  it("refuses anything else, including look-alikes and a missing Origin", () => {
    for (const o of ["https://a.example.evil.com", "http://a.example", "https://a.example:8443", "https://evil.example", "null", "", undefined]) {
      expect(matchWebOrigin(list, o), String(o)).toBeNull();
    }
  });
});

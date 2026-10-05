// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// M6.6 date-filter consistency audit, kept as a guard: screens must read "today" and calendar days in the HOSPITAL's
// timezone, never the browser's. These browser-local Date APIs would silently use the viewer's zone, so none may appear
// in UI code. (Pure `YYYY-MM-DD` arithmetic in UTC — `Date.parse(`${ymd}T00:00:00Z`)` — is fine and not matched.)

const ROOTS = [path.resolve(__dirname, "../../app"), path.resolve(__dirname, "../../components"), path.resolve(__dirname, "../../lib"), path.resolve(__dirname, "../../../../packages/ui/src")];
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\.(getHours|getMinutes|getDay|getDate|getMonth|getFullYear)\(\)/, why: "browser-local calendar read" },
  { re: /\.setHours\(|\.setDate\(|\.setMonth\(/, why: "browser-local calendar write" },
  { re: /\.toLocaleDateString\((?![^)]*timeZone)/, why: "toLocaleDateString without a timeZone" },
  { re: /\.toLocaleTimeString\((?![^)]*timeZone)/, why: "toLocaleTimeString without a timeZone" },
  { re: /\.toDateString\(\)/, why: "browser-local date string" },
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "__tests__" || e.name === ".next" ? [] : files(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

describe("hospital time: no browser-local date reads in UI code", () => {
  it("none of the forbidden Date APIs appear", () => {
    const hits: string[] = [];
    for (const f of ROOTS.flatMap(files)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        for (const { re, why } of FORBIDDEN) if (re.test(line)) hits.push(`${path.relative(process.cwd(), f)}:${i + 1} ${why}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

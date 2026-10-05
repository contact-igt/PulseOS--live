import { beforeEach, describe, expect, it } from "vitest";
import { replaceUrlParams } from "../urlParams";

describe("replaceUrlParams (the one writer every view/filter hook shares)", () => {
  beforeEach(() => window.history.replaceState(null, "", "/my-work"));

  it("writes the patch into the live URL without adding a history entry", () => {
    const before = window.history.length;
    replaceUrlParams({ view: "board", reason: "no_show" });
    expect(window.location.pathname).toBe("/my-work");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("board");
    expect(new URLSearchParams(window.location.search).get("reason")).toBe("no_show");
    expect(window.history.length).toBe(before);
  });

  it("successive writes build on each other — a second writer never drops the first one's params", () => {
    replaceUrlParams({ stage: "waiting" });
    replaceUrlParams({ view: "flow" });
    replaceUrlParams({ q: "asha" });
    expect(window.location.search).toBe("?stage=waiting&view=flow&q=asha");
  });

  it("undefined or empty values delete the param; the query string disappears when nothing is left", () => {
    window.history.replaceState(null, "", "/leads?status=new&view=board");
    replaceUrlParams({ status: undefined });
    expect(window.location.search).toBe("?view=board");
    replaceUrlParams({ view: "" });
    expect(window.location.search).toBe("");
    expect(window.location.href.endsWith("/leads")).toBe(true);
  });

  it("keeps unrelated params and the hash", () => {
    window.history.replaceState(null, "", "/treatments?service=Cataract&view=pipeline#top");
    replaceUrlParams({ view: undefined });
    expect(window.location.search).toBe("?service=Cataract");
    expect(window.location.hash).toBe("#top");
  });

  it("the same value written twice is a no-op", () => {
    replaceUrlParams({ view: "board" });
    const href = window.location.href;
    replaceUrlParams({ view: "board" });
    expect(window.location.href).toBe(href);
  });
});

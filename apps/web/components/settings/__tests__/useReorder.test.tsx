import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReorder } from "../SortableList";

const LABELS: Record<string, string> = { a: "New enquiry", b: "Needs callback", c: "Wrong number" };
const base = { label: (id: string) => LABELS[id] ?? id };
const list = [{ id: "a" }, { id: "b" }, { id: "c" }];

function setup(save: (group: "contacted", ids: string[]) => Promise<unknown>, refresh = vi.fn(async () => {})) {
  return { refresh, ...renderHook(() => useReorder<"contacted">({ ...base, save, refresh })) };
}

describe("useReorder", () => {
  it("shows the new order at once, saves it, and announces the new position", async () => {
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { result } = setup(save);

    let done!: Promise<void>;
    act(() => {
      done = result.current.reorder("contacted", ["b", "a", "c"], "b");
    });
    expect(result.current.ordered("contacted", list).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(result.current.isSaving("contacted")).toBe(true);
    expect(result.current.statusOf("b")).toBe("saving");
    expect(save).toHaveBeenCalledWith("contacted", ["b", "a", "c"]);

    await act(async () => {
      release();
      await done;
    });
    expect(result.current.isSaving("contacted")).toBe(false);
    expect(result.current.statusOf("b")).toBe("idle");
    expect(result.current.announcement).toBe("Needs callback moved to position 1 of 3.");
    expect(result.current.error).toBeNull();
  });

  it("puts the old order back on a failed save, says so, and marks the moved row failed", async () => {
    const { result } = setup(vi.fn(async () => { throw new Error("boom"); }));
    await act(async () => {
      await result.current.reorder("contacted", ["c", "a", "b"], "c", "grip", ["a", "b", "c"]);
    });
    expect(result.current.ordered("contacted", list).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(result.current.error).toMatch(/put back/i);
    expect(result.current.statusOf("c")).toBe("failed");
    expect(result.current.announcement).toMatch(/Wrong number is back at position 3 of 3/);
  });

  it("keeps items that were not part of the saved order after the ordered ones", async () => {
    let release!: () => void;
    const { result } = setup(vi.fn(() => new Promise<void>((r) => (release = r))));
    act(() => void result.current.reorder("contacted", ["b", "a"], "b"));
    expect(result.current.ordered("contacted", list).map((x) => x.id)).toEqual(["b", "a", "c"]);
    await act(async () => release());
  });

  it("refreshes after a successful save and not after a failed one", async () => {
    const ok = setup(vi.fn(async () => {}));
    await act(async () => void (await ok.result.current.reorder("contacted", ["b", "a", "c"], "b")));
    expect(ok.refresh).toHaveBeenCalledTimes(1);
    const bad = setup(vi.fn(async () => { throw new Error("x"); }));
    await act(async () => void (await bad.result.current.reorder("contacted", ["b", "a", "c"], "b")));
    expect(bad.refresh).not.toHaveBeenCalled();
  });

  it("ignores a second reorder while one is saving", async () => {
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { result } = setup(save);
    act(() => void result.current.reorder("contacted", ["b", "a", "c"], "b"));
    await act(async () => void (await result.current.reorder("contacted", ["c", "b", "a"], "c")));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("records which control to give focus back to after an arrow move", async () => {
    const { result } = setup(vi.fn(async () => {}));
    await act(async () => void (await result.current.reorder("contacted", ["b", "a", "c"], "b", "down")));
    expect(result.current.focusRequest).toMatchObject({ id: "b", control: "down" });
  });

  it("rows that are not part of the saved order (archived ones) keep their place while a save is in flight", async () => {
    let release!: () => void;
    const { result } = setup(vi.fn(() => new Promise<void>((r) => (release = r))));
    const withArchived = [{ id: "a" }, { id: "x-archived" }, { id: "b" }, { id: "c" }];
    act(() => void result.current.reorder("contacted", ["c", "b", "a"], "c"));
    // The three active rows swap among THEIR slots; the archived row stays second.
    expect(result.current.ordered("contacted", withArchived).map((x) => x.id)).toEqual(["c", "x-archived", "b", "a"]);
    await act(async () => release());
  });

  it("saves in different groups are independent: one group saving does not silently swallow a move in another", async () => {
    const releases: (() => void)[] = [];
    const save = vi.fn((_g: string) => new Promise<void>((r) => releases.push(r)));
    const { result } = renderHook(() => useReorder<"one" | "two">({ ...base, save, refresh: async () => {} }));
    act(() => void result.current.reorder("one", ["b", "a"], "b"));
    act(() => void result.current.reorder("two", ["c", "a"], "c"));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => releases.forEach((r) => r()));
  });

  it("a failed row stops looking failed after a while, and on the next move", async () => {
    vi.useFakeTimers();
    try {
      const { result } = setup(vi.fn(async () => { throw new Error("x"); }));
      await act(async () => void (await result.current.reorder("contacted", ["b", "a", "c"], "b", "grip", ["a", "b", "c"])));
      expect(result.current.statusOf("b")).toBe("failed");
      expect(result.current.error).not.toBeNull();
      await act(async () => void vi.advanceTimersByTime(9000));
      expect(result.current.statusOf("b")).toBe("idle");
      expect(result.current.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

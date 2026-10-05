import { describe, expect, it, vi } from "vitest";
import { startJobRunner, runDueJobs, type DueJob } from "../jobs/runner.js";

const NOW = new Date("2026-10-02T10:00:00Z");

describe("runDueJobs", () => {
  it("runs every job with the same explicit clock and reports each result", async () => {
    const a = vi.fn(async (now: Date) => ({ processed: now.getTime() === NOW.getTime() ? 2 : 0 }));
    const b = vi.fn(async () => ({ processed: 1 }));
    const out = await runDueJobs([{ name: "a", run: a }, { name: "b", run: b }], NOW);
    expect(out).toEqual([{ name: "a", ok: true, result: { processed: 2 } }, { name: "b", ok: true, result: { processed: 1 } }]);
  });

  it("a failing job never stops the others and is reported, not thrown", async () => {
    const jobs: DueJob[] = [
      { name: "broken", run: async () => { throw new Error("boom"); } },
      { name: "fine", run: async () => ({ processed: 3 }) },
    ];
    const out = await runDueJobs(jobs, NOW);
    expect(out[0]).toMatchObject({ name: "broken", ok: false, error: "boom" });
    expect(out[1]).toMatchObject({ name: "fine", ok: true });
  });
});

describe("startJobRunner", () => {
  it("ticks on an interval without overlapping itself, and stops cleanly", async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    let ticks = 0;
    const slow: DueJob = {
      name: "slow",
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        ticks++;
        await new Promise((r) => setTimeout(r, 250));
        running--;
        return {};
      },
    };
    const stop = startJobRunner([slow], { intervalMs: 100, log: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    const after = ticks;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(after); // stopped
    expect(ticks).toBeGreaterThan(1);
    expect(maxRunning).toBe(1); // a slow tick is never started twice at once
    vi.useRealTimers();
  });
});

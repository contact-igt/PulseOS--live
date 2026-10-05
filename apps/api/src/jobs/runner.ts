// A tiny runner for due-time work (conversation summaries, appointment reminders...). The *schedule* of each
// piece of work lives in the database (a due-at column), never in memory: the runner just wakes up every few
// seconds and asks each job "is anything due as of now?". A restart therefore loses nothing, and jobs are
// written to be idempotent, so several workers (or a repeated tick) are harmless.

export interface DueJob {
  name: string;
  run: (now: Date) => Promise<Record<string, unknown> | void>;
}

export type JobOutcome = { name: string; ok: true; result: Record<string, unknown> | void } | { name: string; ok: false; error: string };

/** Run every job once at `now`. A failing job is reported and never prevents the others from running. */
export async function runDueJobs(jobs: DueJob[], now: Date): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  for (const job of jobs) {
    try {
      out.push({ name: job.name, ok: true, result: await job.run(now) });
    } catch (err) {
      out.push({ name: job.name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Start ticking. Returns a stop function. A tick that is still running is never started again. */
export function startJobRunner(jobs: DueJob[], opts: { intervalMs?: number; log?: (msg: string, detail?: unknown) => void } = {}): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  const log = opts.log ?? ((msg, detail) => console.error(msg, detail ?? ""));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const o of await runDueJobs(jobs, new Date())) if (!o.ok) log(`job ${o.name} failed`, o.error);
    } finally {
      busy = false;
    }
  }, intervalMs);
  // Do not keep the process alive just for the runner.
  timer.unref?.();
  return () => clearInterval(timer);
}

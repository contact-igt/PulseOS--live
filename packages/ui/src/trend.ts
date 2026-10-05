import type { AnalyticsBucket } from "@pulseos/types";

type BucketSpan = Pick<AnalyticsBucket, "key" | "to">;

/** Index of the bucket containing `today` (still collecting data), or -1. */
export function inProgressIndex(buckets: BucketSpan[], today: string | undefined): number {
  return today ? buckets.findIndex((b) => b.key <= today && today <= b.to) : -1;
}

/**
 * The bucket containing `today` is still collecting data, so its count is not
 * comparable to finished buckets. Split a series so that bucket sits on its own
 * "open" segment (drawn dashed, joined to the last complete point) instead of
 * reading as a real drop.
 */
export function splitInProgress(buckets: BucketSpan[], values: number[], today: string) {
  const openIndex = inProgressIndex(buckets, today);
  return {
    openIndex,
    closed: values.map((v, i) => (openIndex !== -1 && i >= openIndex ? null : v)),
    open: values.map((v, i) => (openIndex !== -1 && (i === openIndex || i === openIndex - 1) ? v : null)),
  };
}

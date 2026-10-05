/**
 * "Now" for a worker that must see rows the test has JUST enqueued.
 *
 * Queue rows get their due time from the DATABASE clock (`default now()`, microsecond precision). A JS `new Date()` read
 * right after the insert is truncated to whole milliseconds, so it can be up to a millisecond EARLIER than the row's
 * due time and the row is skipped as "not due yet" (measured: ~96% of immediate checks on a local database, and the
 * cause of an intermittent failure in m7-review-fixes). Passing a clock a little ahead removes the race without
 * changing what the worker does.
 */
export const dueNow = (): Date => new Date(Date.now() + 1000);

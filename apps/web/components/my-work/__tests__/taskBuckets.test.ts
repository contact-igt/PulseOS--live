import { describe, expect, it } from "vitest";
import type { TaskRow } from "@pulseos/types";
import { allowedBucketMoves, dueBucket, groupByBucket, rescheduleTarget } from "../taskBuckets";

const IST = "Asia/Kolkata";

function task(dueAt: string, status: TaskRow["status"] = "pending"): TaskRow {
  return {
    id: dueAt, patientId: "p", patientName: "Test", journeyId: null, journeyType: null, source: null, assignedTo: "u", assignedToName: "U",
    followUpTypeId: null, followUpTypeKey: null, typeLabel: "Callback",
    type: "CALLBACK", priority: "normal", status, reason: "manual_task", notes: null, dueAt, completedAt: null, createdAt: dueAt,
  };
}

describe("dueBucket (hospital timezone, never UTC or the browser zone)", () => {
  const now = new Date("2026-09-30T04:30:00Z"); // 10:00 IST, Wed 30 Sep

  it("a task due at IST 00:15 tomorrow is Upcoming, even though its UTC date is today", () => {
    // 2026-09-30T18:45Z = 1 Oct 00:15 IST; the UTC calendar would call it 30 Sep (today).
    expect(dueBucket(task("2026-09-30T18:45:00Z"), now, IST)).toBe("upcoming");
    expect(dueBucket(task("2026-09-30T18:45:00Z"), now, "UTC")).toBe("today");
  });

  it("a task due at IST 00:15 today is Today while still ahead, Overdue once passed", () => {
    const due = "2026-09-29T18:45:00Z"; // 30 Sep 00:15 IST (UTC date: 29 Sep)
    expect(dueBucket(task(due), new Date("2026-09-29T18:40:00Z"), IST)).toBe("today");
    expect(dueBucket(task(due), now, IST)).toBe("overdue");
  });

  it("later today is Today; completed and cancelled tasks are Done regardless of date", () => {
    expect(dueBucket(task("2026-09-30T18:15:00Z"), now, IST)).toBe("today"); // 23:45 IST
    expect(dueBucket(task("2026-09-01T00:00:00Z", "completed"), now, IST)).toBe("done");
    expect(dueBucket(task("2026-12-01T00:00:00Z", "cancelled"), now, IST)).toBe("done");
    expect(dueBucket(task("2026-09-30T03:00:00Z", "in_progress"), now, IST)).toBe("overdue");
  });

  it("groups every task into exactly one bucket", () => {
    const rows = [task("2026-09-30T18:45:00Z"), task("2026-09-29T18:45:00Z"), task("2026-09-30T18:15:00Z"), task("2026-09-01T00:00:00Z", "completed")];
    const g = groupByBucket(rows, now, IST);
    expect([g.overdue.length, g.today.length, g.upcoming.length, g.done.length]).toEqual([1, 1, 1, 1]);
  });
});

describe("rescheduleTarget (a board move is a real reschedule, computed in hospital time)", () => {
  const overdue = task("2026-09-28T04:30:00Z"); // 28 Sep 10:00 IST

  it("to Today keeps the original local time when it is still ahead", () => {
    expect(rescheduleTarget(overdue, "today", new Date("2026-09-30T03:00:00Z"), IST)).toBe("2026-09-30T04:30:00.000Z");
  });

  it("to Today moves to the next 15-minute slot when the original time has passed", () => {
    expect(rescheduleTarget(overdue, "today", new Date("2026-09-30T06:00:00Z"), IST)).toBe("2026-09-30T06:15:00.000Z"); // 11:45 IST
  });

  it("to Upcoming is tomorrow (hospital day) at the original local time, including 00:15", () => {
    expect(rescheduleTarget(overdue, "upcoming", new Date("2026-09-30T06:00:00Z"), IST)).toBe("2026-10-01T04:30:00.000Z");
    expect(rescheduleTarget(task("2026-09-29T18:45:00Z"), "upcoming", new Date("2026-09-30T06:00:00Z"), IST)).toBe("2026-09-30T18:45:00.000Z");
  });
});

describe("allowedBucketMoves (only moves that map to a real endpoint)", () => {
  const now = new Date("2026-09-30T04:30:00Z");
  it("open tasks can move to Today / Upcoming (reschedule) or Done (complete); never back into Overdue", () => {
    expect(allowedBucketMoves(task("2026-09-28T04:30:00Z"), true, now, IST)).toEqual(["today", "upcoming", "done"]);
    expect(allowedBucketMoves(task("2026-09-30T10:00:00Z"), true, now, IST)).toEqual(["upcoming", "done"]);
    expect(allowedBucketMoves(task("2026-10-03T10:00:00Z"), true, now, IST)).toEqual(["today", "done"]);
  });
  it("done tasks and callers without MANAGE_TASKS get no moves", () => {
    expect(allowedBucketMoves(task("2026-09-28T04:30:00Z", "completed"), true, now, IST)).toEqual([]);
    expect(allowedBucketMoves(task("2026-09-28T04:30:00Z"), false, now, IST)).toEqual([]);
  });
});

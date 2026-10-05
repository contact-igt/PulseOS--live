"use client";

import { useCallback, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api, ApiError } from "@pulseos/api-client";
import type { TaskRow } from "@pulseos/types";

const REASON_TEXT: Record<string, string> = {
  already_completed: "This task was already completed.",
  task_not_found: "This task no longer exists.",
};

/** A human sentence for a rejected task action (never a raw error code). */
export function taskErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (REASON_TEXT[err.message]) return REASON_TEXT[err.message];
    if (err.status === 403) return "You don't have permission to change tasks.";
    if (err.status === 409) return "Someone else changed this task. Refresh and try again.";
  }
  return "Could not save this change. Try again.";
}

/**
 * The ONLY task actions My Work offers, each through its existing endpoint:
 * complete, reschedule, reassign (to me) and note. Updates are optimistic on
 * the shared tasks query (every view reads it), revert on server reject and
 * leave an inline, per-task error. Nothing here throws to the caller.
 */
export function useTaskActions(tasksKey: QueryKey) {
  const queryClient = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    // patient360 covers Patient 360 (incl. its Upcoming list) for the task's patient.
    await Promise.all(["tasks", "dashboard", "patient360"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  }, [queryClient]);

  const run = useCallback(
    async (task: TaskRow, patch: Partial<TaskRow>, request: () => Promise<TaskRow>): Promise<TaskRow | null> => {
      await queryClient.cancelQueries({ queryKey: tasksKey });
      const snapshot = queryClient.getQueryData<TaskRow[]>(tasksKey);
      queryClient.setQueryData<TaskRow[]>(tasksKey, (rows) => rows?.map((r) => (r.id === task.id ? { ...r, ...patch } : r)));
      setErrors((e) => {
        if (!(task.id in e)) return e;
        const next = { ...e };
        delete next[task.id];
        return next;
      });
      try {
        const saved = await request();
        await refresh();
        return saved ?? null;
      } catch (err) {
        queryClient.setQueryData(tasksKey, snapshot);
        setErrors((e) => ({ ...e, [task.id]: taskErrorMessage(err) }));
        void refresh();
        return null;
      }
    },
    [queryClient, tasksKey, refresh],
  );

  return {
    errors,
    clearError: (id: string) =>
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      }),
    complete: (task: TaskRow) => run(task, { status: "completed", completedAt: new Date().toISOString() }, () => api.completeTask(task.id)),
    reschedule: (task: TaskRow, dueAt: string) => run(task, { dueAt }, () => api.rescheduleTask(task.id, dueAt)),
    assignTo: (task: TaskRow, userId: string, userName: string | null) => run(task, { assignedTo: userId, assignedToName: userName }, () => api.reassignTask(task.id, userId)),
    addNote: (task: TaskRow, notes: string) => run(task, { notes }, () => api.addTaskNote(task.id, notes)),
    /** For the board: throws (so the board rolls the card back) and resolves only once the refetch has landed. */
    moveStrict: async (request: () => Promise<TaskRow>) => {
      try {
        await request();
      } catch (err) {
        throw new Error(taskErrorMessage(err));
      }
      await refresh();
    },
  };
}

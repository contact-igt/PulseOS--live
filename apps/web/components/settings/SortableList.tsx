"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type Announcements, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// The one drag-to-reorder behaviour for Settings lists (CRM Fields, Workflow Outcomes, Follow-up Types).
//
//   - The six-dot handle is the PRIMARY control and the ONLY drag activator: the rest of a row keeps its normal click
//     targets. Dragging works with a pointer, a finger, or the keyboard (Space to pick up, arrows, Space to drop).
//   - Move up / Move down are the quiet SECONDARY control: they stay in the tab order and are always shown on touch
//     screens, but on a pointer device they only appear when the row is hovered or focused.
//   - One save path (`useReorder`) for drag and arrows: the new order shows at once, is saved, and is put back with an
//     inline message if the save fails. Every move is announced to screen readers ("Needs callback moved to position 2
//     of 8."), and keyboard focus stays on the row that moved.
//   - Row states: idle, hover, dragging (lifted), drop-target, saving, failed-and-put-back. Motion is a short shift that
//     stops under prefers-reduced-motion.

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export type RowStatus = "idle" | "saving" | "failed";
export type OrderControl = "grip" | "up" | "down";
type FocusRequest = { id: string; control: OrderControl; n: number };

/** Shared reorder state: optimistic order, save, roll back on failure, announce, and where focus should go next. */
export function useReorder<G extends string>({ save, refresh, label }: { save: (group: G, orderedIds: string[]) => Promise<unknown>; refresh: () => Promise<unknown> | void; label: (id: string) => string }) {
  const [pending, setPending] = useState<Partial<Record<G, string[]>>>({});
  const [movedId, setMovedId] = useState<string | null>(null);
  const [status, setStatus] = useState<RowStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  // One guard per group: a save in one group never swallows a move made in another.
  const inFlight = useRef(new Set<G>());
  const failTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);

  const reorder = useCallback(
    async (group: G, orderedIds: string[], moved: string, control: OrderControl = "grip", before?: string[]) => {
      if (inFlight.current.has(group)) return;
      inFlight.current.add(group);
      if (failTimer.current) clearTimeout(failTimer.current);
      const position = orderedIds.indexOf(moved) + 1;
      const name = label(moved);
      setError(null);
      setMovedId(moved);
      setStatus("saving");
      setFocusRequest({ id: moved, control, n: ++counter.current });
      setPending((p) => ({ ...p, [group]: orderedIds }));
      try {
        await save(group, orderedIds);
        await refresh();
        setStatus("idle");
        setAnnouncement(`${name} moved to position ${position} of ${orderedIds.length}.`);
      } catch {
        setStatus("failed");
        setError("Couldn't save the new order — it has been put back. Try again.");
        // The failure is shown until the next move, or for a few seconds — it never lingers after unrelated actions.
        failTimer.current = setTimeout(() => {
          setStatus("idle");
          setError(null);
        }, 8000);
        const back = before ? before.indexOf(moved) + 1 : 0;
        setAnnouncement(back > 0 ? `Couldn't save the new order. ${name} is back at position ${back} of ${orderedIds.length}.` : `Couldn't save the new order. ${name} is back where it was.`);
      } finally {
        inFlight.current.delete(group);
        setPending(({ [group]: _done, ...rest }) => rest as Partial<Record<G, string[]>>);
      }
    },
    [save, refresh, label],
  );

  /**
   * The list in its optimistic order while a save is in flight. Rows that are not part of the saved order (archived ones)
   * keep the place they had: the listed rows are re-dealt into the slots the listed rows already occupied.
   */
  const ordered = useCallback(
    <T extends { id: string }>(group: G, list: T[]): T[] => {
      const order = pending[group];
      if (!order) return list;
      const byId = new Map(list.map((x) => [x.id, x]));
      const listed = order.map((id) => byId.get(id)).filter((x): x is T => !!x);
      const inOrder = new Set(listed.map((x) => x.id));
      let next = 0;
      return list.map((x) => (inOrder.has(x.id) ? listed[next++]! : x));
    },
    [pending],
  );

  return {
    reorder,
    ordered,
    error,
    clearError: () => setError(null),
    announcement,
    focusRequest,
    isSaving: (group: G) => !!pending[group],
    statusOf: (id: string): RowStatus => (id === movedId ? status : "idle"),
  };
}

/** Visually hidden polite live region: the spoken confirmation after every move. */
export function ReorderStatus({ message }: { message: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="reorder-status">
      {message}
    </p>
  );
}

export function SortableGroup({ items, onReorder, children }: { items: { id: string; label: string }[]; onReorder: (orderedIds: string[], movedId: string) => void; children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const label = (id: string | number) => items.find((i) => i.id === id)?.label ?? "item";
  const pos = (id: string | number) => `position ${items.findIndex((i) => i.id === id) + 1} of ${items.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${label(active.id)}, ${pos(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${label(active.id)} is over ${pos(over.id)}.` : `${label(active.id)} is not over a position.`),
    onDragEnd: ({ active, over }) => (over ? `${label(active.id)} dropped at ${pos(over.id)}.` : `${label(active.id)} dropped back where it was.`),
    onDragCancel: ({ active }) => `Moving ${label(active.id)} cancelled; it is back where it was.`,
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(ids, from, to), String(e.active.id));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ announcements }}>
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** Row chrome for every state; callers add their own layout classes. `group` lets the quiet arrows appear on hover. */
function rowStateClass({ isDragging, isOver, status, archived }: { isDragging: boolean; isOver: boolean; status: RowStatus; archived: boolean }): string {
  const base = "group relative bg-white transition-colors duration-100 motion-reduce:transition-none";
  if (isDragging) return `${base} z-10 cursor-grabbing rounded-card shadow-glass ring-2 ring-primary-400`;
  if (status === "failed") return `${base} bg-danger-100/40 ring-1 ring-inset ring-danger-500`;
  if (isOver) return `${base} bg-primary-50 ring-1 ring-inset ring-primary-300`;
  if (status === "saving") return `${base} opacity-80`;
  return `${base} ${archived ? "bg-neutral-50 text-ink-2" : "hover:bg-primary-50/50"}`;
}

/** A sortable list row: spread `rowProps` on the <li> and render <RowOrderControls> inside it. */
export function useSortableRow(id: string, disabled: boolean, opts: { status?: RowStatus; archived?: boolean } = {}) {
  const reducedMotion = usePrefersReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver } = useSortable({ id, disabled, transition: { duration: 150, easing: "ease-out" } });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition: reducedMotion ? undefined : transition };
  const status = opts.status ?? "idle";
  return {
    isDragging,
    rowProps: {
      ref: setNodeRef,
      style,
      className: rowStateClass({ isDragging, isOver: isOver && !isDragging, status, archived: !!opts.archived }),
      "data-dragging": isDragging || undefined,
      "data-drop-target": (isOver && !isDragging) || undefined,
      "data-status": status === "idle" ? undefined : status,
      "aria-busy": status === "saving" || undefined,
    } as const,
    gripProps: { ref: setActivatorNodeRef, ...attributes, ...listeners } as const,
  };
}

const QUIET_BTN =
  "inline-flex h-11 w-11 items-center justify-center rounded-control text-neutral-500 hover:bg-primary-50 hover:text-ink aria-disabled:cursor-wait aria-disabled:opacity-50 disabled:opacity-25 sm:h-7 sm:w-6 " +
  // Pointer devices: only on row hover / keyboard focus. Touch screens (no hover): always there.
  "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100";

/**
 * [six-dot handle] [position] [quiet up/down]. `ids` are the test ids; `locked` keeps the buttons focusable but inert
 * (a save is in flight), `disabled` removes them (archived rows). Focus returns to the control that was used.
 */
export function RowOrderControls({
  rowId,
  label,
  position,
  total,
  disabled,
  locked,
  dragging,
  gripProps,
  onMove,
  focusRequest,
  ids,
}: {
  rowId: string;
  label: string;
  position: number;
  total: number;
  disabled: boolean;
  locked: boolean;
  dragging: boolean;
  gripProps: Record<string, unknown>;
  onMove: (delta: -1 | 1) => void;
  focusRequest: { id: string; control: OrderControl; n: number } | null;
  ids: { drag: string; up: string; down: string; position?: string };
}) {
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const grip = useRef<HTMLButtonElement | null>(null);
  const isFirst = position <= 1;
  const isLast = position >= total;

  // Keep keyboard focus on the row that moved: the order changes the DOM, so hand focus back to the control just used.
  useLayoutEffect(() => {
    if (!focusRequest || focusRequest.id !== rowId || focusRequest.control === "grip") return;
    const wanted = focusRequest.control === "up" ? up.current : down.current;
    const target = wanted && !wanted.disabled ? wanted : grip.current;
    // Only when the move cost focus (the DOM node was re-inserted and focus fell to <body>) — never steal it from
    // wherever the person has moved on to since.
    const active = document.activeElement;
    if (active && active !== document.body && active !== target) return;
    target?.focus({ preventScroll: true });
  }, [focusRequest, rowId, position]);

  const { ref: setActivator, ...restGrip } = gripProps as { ref?: (el: HTMLElement | null) => void } & Record<string, unknown>;
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        {...restGrip}
        ref={(el) => {
          grip.current = el;
          setActivator?.(el);
        }}
        disabled={disabled}
        aria-label={`Reorder ${label}, position ${position} of ${total}. Press space to pick up, arrow keys to move, space to drop.`}
        aria-roledescription="sortable item"
        className={`inline-flex h-11 w-11 touch-none items-center justify-center rounded-control text-neutral-500 hover:bg-primary-50 hover:text-primary-700 focus-visible:text-primary-700 disabled:opacity-30 group-hover:text-ink-2 sm:h-8 sm:w-7 ${dragging ? "cursor-grabbing text-primary-700" : "cursor-grab"}`}
        data-testid={ids.drag}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <span className="w-5 text-center text-[11px] tabular-nums text-ink-2" aria-hidden="true" data-testid={ids.position}>
        {position}
      </span>
      <button ref={up} type="button" className={QUIET_BTN} disabled={disabled || isFirst} aria-disabled={locked || undefined} onClick={() => !locked && onMove(-1)} aria-label={`Move ${label} up`} data-testid={ids.up}>
        <ArrowUp size={13} aria-hidden="true" />
      </button>
      <button ref={down} type="button" className={QUIET_BTN} disabled={disabled || isLast} aria-disabled={locked || undefined} onClick={() => !locked && onMove(1)} aria-label={`Move ${label} down`} data-testid={ids.down}>
        <ArrowDown size={13} aria-hidden="true" />
      </button>
    </div>
  );
}

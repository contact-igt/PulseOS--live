"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CircleAlert, Loader2, MoveRight, X } from "lucide-react";

export interface KanbanColumn {
  key: string;
  title: string;
  /** Optional one-line helper under the title. */
  hint?: string;
}

export interface KanbanCardState {
  /** True while an `onMove` request for this card is in flight (the card already shows in its target column). */
  pending: boolean;
  error: string | null;
}

export interface KanbanBoardProps<T> {
  columns: KanbanColumn[];
  cards: T[];
  getCardId: (card: T) => string;
  getColumnKey: (card: T) => string;
  /** Card body only. Do not render buttons/links inside if `onCardClick` is set - the primitive wraps the body in the button. */
  renderCard: (card: T, state: KanbanCardState) => ReactNode;
  /** Short name used in accessible labels ("Move Asha Rao to..."). */
  getCardLabel: (card: T) => string;
  onCardClick?: (card: T) => void;
  /**
   * Moving is OPTIONAL. With no `onMove` the board is strictly read-only: no
   * drag handle, no draggable attribute, no "Move to..." control.
   * The server stays the authority: list only the columns the backend will accept.
   */
  getAllowedMoves?: (card: T) => string[];
  /**
   * Persist the move. Reject (throw) to roll back: the card returns to its original
   * column and shows the error. Resolve only once the move is saved AND your cache
   * reflects it (await your refetch/invalidate, or update the cache), so the card
   * doesn't flicker back.
   */
  onMove?: (card: T, toColumn: string) => Promise<void>;
  ariaLabel: string;
  emptyColumnMessage?: string;
  className?: string;
}

interface MoveState {
  to: string;
  status: "pending" | "done" | "error";
  error?: string;
}

const SETTLE_MS = 5000;

export function KanbanBoard<T>({
  columns,
  cards,
  getCardId,
  getColumnKey,
  renderCard,
  getCardLabel,
  onCardClick,
  getAllowedMoves,
  onMove,
  ariaLabel,
  emptyColumnMessage = "No cards",
  className = "",
}: KanbanBoardProps<T>) {
  const movable = Boolean(onMove);
  const [moves, setMoves] = useState<Record<string, MoveState>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Keyboard moves re-mount the card in its new column (and hide its Move button
  // while pending): focus follows the card there, and one persistent polite live
  // region announces the outcome.
  const boardRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  // A finished move keeps its optimistic position until the caller's data agrees (or SETTLE_MS elapses).
  useEffect(() => {
    const done = Object.entries(moves).filter(([, m]) => m.status === "done");
    if (done.length === 0) return;
    const byId = new Map(cards.map((c) => [getCardId(c), getColumnKey(c)]));
    const stale = done.filter(([id, m]) => byId.get(id) === m.to || !byId.has(id)).map(([id]) => id);
    if (stale.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile optimistic overlay with fresh props
      setMoves((prev) => {
        const next = { ...prev };
        for (const id of stale) delete next[id];
        return next;
      });
    }
    const timer = setTimeout(() => {
      setMoves((prev) => Object.fromEntries(Object.entries(prev).filter(([, m]) => m.status !== "done")));
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [cards, moves, getCardId, getColumnKey]);

  const allowedFor = useCallback(
    (card: T): string[] => {
      if (!onMove || !getAllowedMoves) return [];
      const from = getColumnKey(card);
      return getAllowedMoves(card).filter((k) => k !== from && columns.some((c) => c.key === k));
    },
    [onMove, getAllowedMoves, getColumnKey, columns],
  );

  const run = useCallback(
    async (card: T, to: string, refocus = false) => {
      if (!onMove) return;
      const id = getCardId(card);
      const name = getCardLabel(card);
      const title = columns.find((c) => c.key === to)?.title ?? to;
      setMoves((p) => ({ ...p, [id]: { to, status: "pending" } }));
      setAnnouncement(`Moving ${name} to ${title}…`);
      if (refocus) setFocusId(id);
      try {
        await onMove(card, to);
        setMoves((p) => ({ ...p, [id]: { to, status: "done" } }));
        setAnnouncement(`Moved ${name} to ${title}.`);
      } catch (err) {
        const msg = err instanceof Error && err.message ? err.message : "Could not move this card.";
        setMoves((p) => ({ ...p, [id]: { to, status: "error", error: msg } }));
        setAnnouncement(`Not moved: ${msg}`);
      }
      if (refocus) setFocusId(id);
    },
    [onMove, getCardId, getCardLabel, columns],
  );

  useEffect(() => {
    if (!focusId) return;
    const li = Array.from(boardRef.current?.querySelectorAll<HTMLElement>("li[data-testid]") ?? []).find((el) => el.dataset.testid === `kanban-card-${focusId}`);
    if (li && !li.contains(document.activeElement)) li.querySelector<HTMLElement>("button")?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot focus request
    setFocusId(null);
  }, [focusId, moves]);

  const columnOf = (card: T): string => {
    const m = moves[getCardId(card)];
    return m && m.status !== "error" ? m.to : getColumnKey(card);
  };

  const draggingCard = dragId ? cards.find((c) => getCardId(c) === dragId) : undefined;
  const draggingAllowed = draggingCard ? allowedFor(draggingCard) : [];

  return (
    <div
      ref={boardRef}
      role="group"
      aria-label={ariaLabel}
      data-testid="kanban-board"
      data-readonly={movable ? "false" : "true"}
      className={`flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:thin] ${className}`}
    >
      <p className="sr-only" aria-live="polite" data-testid="kanban-announce">
        {announcement}
      </p>
      {columns.map((col) => {
        const list = cards.filter((c) => columnOf(c) === col.key);
        const canDrop = draggingCard !== undefined && draggingAllowed.includes(col.key);
        const blocked = draggingCard !== undefined && !canDrop && getColumnKey(draggingCard) !== col.key;
        const isTarget = dropTarget === col.key && canDrop;
        return (
          <section
            key={col.key}
            aria-label={`${col.title}, ${list.length} ${list.length === 1 ? "card" : "cards"}`}
            data-testid={`kanban-col-${col.key}`}
            data-droppable={draggingCard ? String(canDrop) : undefined}
            onDragOver={(e) => {
              if (!canDrop) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropTarget(col.key);
            }}
            onDragLeave={() => setDropTarget((t) => (t === col.key ? null : t))}
            onDrop={(e) => {
              e.preventDefault();
              setDropTarget(null);
              if (draggingCard && canDrop) void run(draggingCard, col.key);
              setDragId(null);
            }}
            className={`flex w-72 shrink-0 snap-start flex-col rounded-card border bg-surface-muted transition sm:w-64 lg:w-72 ${
              isTarget ? "border-primary-500 ring-2 ring-primary-300" : canDrop ? "border-dashed border-primary-400" : "border-line"
            } ${blocked ? "opacity-50" : ""}`}
          >
            <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0">
                <h3 className="truncate text-xs font-semibold text-ink">{col.title}</h3>
                {col.hint && <p className="truncate text-[11px] text-ink-2">{col.hint}</p>}
              </div>
              <span className="rounded-chip bg-white px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2 ring-1 ring-inset ring-line" aria-hidden="true">
                {list.length}
              </span>
            </header>
            {draggingCard && (canDrop || blocked) && (
              <p className="px-3 pt-2 text-[11px] font-medium text-ink-2" aria-hidden="true">
                {canDrop ? "Drop to move here" : "Not available for this card"}
              </p>
            )}
            <ul className="flex min-h-16 flex-1 flex-col gap-2 p-2">
              {list.length === 0 && <li className="px-1 py-3 text-center text-xs text-ink-2">{emptyColumnMessage}</li>}
              {list.map((card) => {
                const id = getCardId(card);
                const move = moves[id];
                const state: KanbanCardState = { pending: move?.status === "pending", error: move?.status === "error" ? (move.error ?? "Could not move this card.") : null };
                const targets = allowedFor(card);
                const draggable = movable && targets.length > 0 && !state.pending;
                return (
                  <li
                    key={id}
                    data-testid={`kanban-card-${id}`}
                    draggable={draggable || undefined}
                    onDragStart={
                      draggable
                        ? (e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", id);
                            setDragId(id);
                          }
                        : undefined
                    }
                    onDragEnd={draggable ? () => (setDragId(null), setDropTarget(null)) : undefined}
                    aria-busy={state.pending || undefined}
                    className={`relative rounded-control border border-line bg-white shadow-panel ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragId === id ? "opacity-60" : ""} ${state.pending ? "opacity-70" : ""}`}
                  >
                    {onCardClick ? (
                      <button
                        type="button"
                        onClick={() => onCardClick(card)}
                        aria-label={getCardLabel(card)}
                        className={`block w-full rounded-control p-2.5 text-left transition hover:bg-primary-50 ${movable && targets.length > 0 ? "pr-10" : ""}`}
                      >
                        {renderCard(card, state)}
                      </button>
                    ) : (
                      <div className={`p-2.5 ${movable && targets.length > 0 ? "pr-10" : ""}`}>{renderCard(card, state)}</div>
                    )}

                    {movable && targets.length > 0 && !state.pending && (
                      <MoveMenu
                        label={getCardLabel(card)}
                        cardId={id}
                        targets={targets.map((k) => ({ key: k, title: columns.find((c) => c.key === k)?.title ?? k }))}
                        open={openMenuId === id}
                        onOpenChange={(o) => setOpenMenuId(o ? id : null)}
                        onPick={(to) => void run(card, to, true)}
                      />
                    )}

                    {state.pending && (
                      <p className="flex items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[11px] font-medium text-primary-700">
                        <Loader2 size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                        Moving to {columns.find((c) => c.key === move?.to)?.title ?? move?.to}...
                      </p>
                    )}
                    {state.error && (
                      <p role="alert" className="flex items-start gap-1.5 border-t border-danger-100 bg-danger-100/50 px-2.5 py-1.5 text-[11px] font-medium text-danger-700">
                        <CircleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span className="min-w-0 flex-1">Not moved: {state.error}</span>
                        <button
                          type="button"
                          aria-label={`Dismiss move error for ${getCardLabel(card)}`}
                          onClick={() => setMoves((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== id)))}
                          className="-m-1 rounded p-1 hover:bg-danger-100"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Move to..." menu: a real button + menu with roving focus (arrows, Home/End, Escape).
// Rendered position: fixed from the trigger's rect so the scrolling board can't clip it.
// ---------------------------------------------------------------------------
function MoveMenu({
  label,
  cardId,
  targets,
  open,
  onOpenChange,
  onPick,
}: {
  label: string;
  cardId: string;
  targets: { key: string; title: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (to: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // The menu only mounts once its position is measured, so focus follows `pos`.
  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (trigger) {
      const r = trigger.getBoundingClientRect();
      const menuW = 208;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- measure trigger once when the menu opens
      setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - menuW, window.innerWidth - menuW - 8)) });
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) onOpenChange(false);
    };
    const onScroll = () => onOpenChange(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, onOpenChange]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      onOpenChange(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move ${label} to...`}
        data-testid={`kanban-move-${cardId}`}
        onClick={() => onOpenChange(!open)}
        className="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center rounded-control text-ink-2 transition hover:bg-primary-100 hover:text-primary-800 pointer-coarse:h-11 pointer-coarse:w-11"
      >
        <MoveRight size={15} aria-hidden="true" />
      </button>
      {open && pos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Move ${label} to`}
          onKeyDown={onMenuKey}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: 208 }}
          className="z-50 rounded-control border border-line-strong bg-white py-1 shadow-glass"
        >
          <p className="px-3 py-1 text-[11px] font-medium text-ink-2" aria-hidden="true">
            Move to...
          </p>
          {targets.map((t) => (
            <button
              key={t.key}
              type="button"
              role="menuitem"
              data-testid={`kanban-move-${cardId}-${t.key}`}
              onClick={() => {
                onOpenChange(false);
                triggerRef.current?.focus();
                onPick(t.key);
              }}
              className="block min-h-9 w-full px-3 text-left text-sm text-ink hover:bg-primary-50 focus-visible:bg-primary-50 pointer-coarse:min-h-11"
            >
              {t.title}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CalendarView } from "../views/CalendarView";
import type { CalendarEvent } from "../views/CalendarView";
import { GanttTimeline } from "../views/GanttTimeline";
import { KanbanBoard } from "../views/KanbanBoard";
import { ViewSwitcher } from "../views/ViewSwitcher";

const NOW = new Date("2026-09-29T05:00:00Z"); // 10:30 IST, Tue 29 Sep

describe("ViewSwitcher", () => {
  const options = [
    { key: "table", label: "Table" },
    { key: "kanban", label: "Kanban" },
    { key: "calendar", label: "Calendar" },
  ];

  it("uses tab semantics with a roving tabindex and arrow-key selection", () => {
    const onChange = vi.fn();
    render(<ViewSwitcher value="table" onChange={onChange} options={options} ariaLabel="Change view" />);
    expect(screen.getByRole("tablist", { name: "Change view" })).toBeTruthy();
    const table = screen.getByRole("tab", { name: "Table" });
    expect(table.getAttribute("aria-selected")).toBe("true");
    expect(table.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Kanban" }).tabIndex).toBe(-1);
    fireEvent.keyDown(table, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("kanban");
    fireEvent.keyDown(table, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("calendar");
    fireEvent.keyDown(table, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("calendar");
  });
});

describe("CalendarView", () => {
  const base = { date: "2026-09-29", timeZone: "Asia/Kolkata", now: NOW, onDateChange: () => {} };

  it("buckets a 20:00Z event on the IST day (29 Sep), not the UTC day (28 Sep)", () => {
    const events: CalendarEvent[] = [{ id: "late", start: "2026-09-28T20:00:00Z", end: "2026-09-28T20:30:00Z", title: "Night review" }];
    render(<CalendarView {...base} mode="month" events={events} />);
    expect(within(screen.getByTestId("calendar-cell-2026-09-29")).getByTestId("calendar-event-late")).toBeTruthy();
    expect(within(screen.getByTestId("calendar-cell-2026-09-28")).queryByTestId("calendar-event-late")).toBeNull();
  });

  it("every event is a button with a time + title + status label; cancelled is distinct without colour", () => {
    const events: CalendarEvent[] = [
      { id: "a", start: "2026-09-29T04:30:00Z", end: "2026-09-29T05:00:00Z", title: "Asha Rao", status: "Confirmed" },
      { id: "b", start: "2026-09-29T06:30:00Z", end: "2026-09-29T07:00:00Z", title: "Ravi Iyer", status: "Cancelled", state: "cancelled" },
    ];
    render(<CalendarView {...base} mode="day" events={events} />);
    expect(screen.getByRole("button", { name: "10:00 am to 10:30 am, Asha Rao, Confirmed" })).toBeTruthy();
    const cancelled = screen.getByRole("button", { name: /Ravi Iyer, Cancelled$/ });
    expect(cancelled.querySelector(".line-through")).not.toBeNull();
  });

  it("a short (compact) block still shows its status as text, not colour alone", () => {
    const events: CalendarEvent[] = [{ id: "s", start: "2026-09-29T04:30:00Z", end: "2026-09-29T05:00:00Z", title: "Asha Rao", status: "Checked in" }];
    render(<CalendarView {...base} mode="day" events={events} />);
    expect(within(screen.getByTestId("calendar-event-s")).getByText("Checked in")).toBeTruthy();
    // One line (time, title, status): a 30-minute block is ~26px, too short for two stacked lines.
    const title = within(screen.getByTestId("calendar-event-s")).getByText("Asha Rao");
    expect(title.parentElement?.textContent).toMatch(/^10:00a.*Asha Rao.*Checked in$/);
  });

  it("lays overlapping events out side by side", () => {
    const events: CalendarEvent[] = [
      { id: "a", start: "2026-09-29T04:30:00Z", end: "2026-09-29T05:30:00Z", title: "A" },
      { id: "b", start: "2026-09-29T05:00:00Z", end: "2026-09-29T06:00:00Z", title: "B" },
    ];
    render(<CalendarView {...base} mode="day" events={events} />);
    const wrapA = screen.getByTestId("calendar-event-a").parentElement!;
    const wrapB = screen.getByTestId("calendar-event-b").parentElement!;
    expect(wrapA.style.width).toBe("50%");
    expect(wrapB.style.width).toBe("50%");
    expect(wrapA.style.left).not.toBe(wrapB.style.left);
  });

  it("month cell caps at N events and '+k more' opens the day", () => {
    const events: CalendarEvent[] = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, start: `2026-09-29T0${4 + i}:00:00Z`, title: `Event ${i}` }));
    const onDateChange = vi.fn();
    const onModeChange = vi.fn();
    render(<CalendarView {...base} onDateChange={onDateChange} onModeChange={onModeChange} mode="month" events={events} maxMonthEvents={3} />);
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-29"));
    expect(screen.getByTestId("calendar-more-2026-09-29").textContent).toBe("+2 more");
    expect(onDateChange).toHaveBeenCalledWith("2026-09-29");
    expect(onModeChange).toHaveBeenCalledWith("day");
  });

  it("onOpenDay, when given, owns 'open this day' (pages whose views are not calendar modes)", () => {
    const events: CalendarEvent[] = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, start: `2026-09-29T0${4 + i}:00:00Z`, title: `Event ${i}` }));
    const onOpenDay = vi.fn();
    const onDateChange = vi.fn();
    render(<CalendarView {...base} onDateChange={onDateChange} onOpenDay={onOpenDay} mode="month" events={events} maxMonthEvents={3} />);
    fireEvent.click(screen.getByTestId("calendar-more-2026-09-29"));
    expect(onOpenDay).toHaveBeenCalledWith("2026-09-29");
    expect(onDateChange).not.toHaveBeenCalled();
  });

  it("an early event widens the grid but the view still opens at the working-day start", () => {
    const events: CalendarEvent[] = [
      { id: "early", start: "2026-09-28T18:45:00Z", title: "Night task" }, // 00:15 IST on 29 Sep
      { id: "day", start: "2026-09-29T04:30:00Z", end: "2026-09-29T05:00:00Z", title: "Morning" },
    ];
    render(<CalendarView {...base} mode="week" events={events} />);
    expect(screen.getByTestId("calendar-event-early")).toBeTruthy();
    expect(screen.getByTestId("calendar-scroll").scrollTop).toBe(8 * 56);
  });

  it("shows the current-time line only on today's column", () => {
    render(<CalendarView {...base} mode="week" events={[]} />);
    expect(screen.getAllByTestId("calendar-now-line")).toHaveLength(1);
  });

  it("navigation buttons step by the active span and Today jumps to the local today", () => {
    const onDateChange = vi.fn();
    render(<CalendarView {...base} date="2026-01-31" onDateChange={onDateChange} mode="month" events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(onDateChange).toHaveBeenLastCalledWith("2026-02-28");
    fireEvent.click(screen.getByRole("button", { name: "Go to today" }));
    expect(onDateChange).toHaveBeenLastCalledWith("2026-09-29");
  });

  it("falls back to the agenda list on a narrow container and stays a grid when mobileFallback is off", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 390, height: 600, top: 0, left: 0, right: 390, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    try {
      const events: CalendarEvent[] = [{ id: "a", start: "2026-09-29T04:30:00Z", title: "Asha Rao" }];
      const { unmount } = render(<CalendarView {...base} mode="month" events={events} />);
      expect(screen.getByTestId("calendar-view").getAttribute("data-mobile-fallback")).toBe("true");
      expect(screen.getByTestId("calendar-agenda")).toBeTruthy();
      unmount();
      render(<CalendarView {...base} mode="month" events={events} mobileFallback="off" />);
      expect(screen.queryByTestId("calendar-agenda")).toBeNull();
      expect(screen.getByTestId("calendar-view").getAttribute("data-mode")).toBe("month");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

describe("KanbanBoard", () => {
  interface Card {
    id: string;
    name: string;
    col: string;
  }
  const columns = [
    { key: "new", title: "New" },
    { key: "active", title: "Active" },
    { key: "done", title: "Done" },
  ];
  const cards: Card[] = [
    { id: "1", name: "Asha", col: "new" },
    { id: "2", name: "Ravi", col: "active" },
  ];
  const common = {
    columns,
    cards,
    getCardId: (c: Card) => c.id,
    getColumnKey: (c: Card) => c.col,
    getCardLabel: (c: Card) => c.name,
    renderCard: (c: Card) => <span>{c.name}</span>,
    ariaLabel: "Board",
  };

  it("is fully read-only without onMove: no move menu, nothing draggable", () => {
    const { container } = render(<KanbanBoard {...common} getAllowedMoves={() => ["active", "done"]} />);
    expect(screen.queryByRole("button", { name: /Move .* to/ })).toBeNull();
    expect(container.querySelector("[draggable]")).toBeNull();
    expect(screen.getByTestId("kanban-board").getAttribute("data-readonly")).toBe("true");
    expect(screen.getByRole("region", { name: "New, 1 card" })).toBeTruthy();
  });

  it("lists only allowed targets in the Move menu and moves optimistically", async () => {
    let resolve!: () => void;
    const onMove = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<KanbanBoard {...common} getAllowedMoves={(c) => (c.col === "new" ? ["active"] : [])} onMove={onMove} />);
    // Ravi has no allowed moves -> no control at all.
    expect(screen.queryByRole("button", { name: "Move Ravi to..." })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Move Asha to..." }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Active"]);
    fireEvent.click(items[0]);
    expect(onMove).toHaveBeenCalledWith(cards[0], "active");
    expect(within(screen.getByTestId("kanban-col-active")).getByTestId("kanban-card-1")).toBeTruthy();
    expect(screen.getByTestId("kanban-announce").textContent).toBe("Moving Asha to Active…");
    expect(screen.getByTestId("kanban-card-1").textContent).toContain("Moving to Active");
    resolve();
    await waitFor(() => expect(screen.getByTestId("kanban-announce").textContent).toBe("Moved Asha to Active."));
  });

  it("opening the Move menu puts focus on its first item (keyboard users need no extra Tab)", async () => {
    render(<KanbanBoard {...common} getAllowedMoves={() => ["active", "done"]} onMove={vi.fn(() => Promise.resolve())} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Asha to..." }));
    const items = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
  });

  it("after a keyboard move, focus follows the card to its new column and the move is announced", async () => {
    render(<KanbanBoard {...common} onCardClick={() => {}} getAllowedMoves={() => ["active"]} onMove={vi.fn(() => Promise.resolve())} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Asha to..." }));
    fireEvent.click((await screen.findAllByRole("menuitem"))[0]);
    const moved = within(screen.getByTestId("kanban-col-active")).getByTestId("kanban-card-1");
    await waitFor(() => expect(moved.contains(document.activeElement)).toBe(true));
    await waitFor(() => expect(screen.getByTestId("kanban-announce").textContent).toBe("Moved Asha to Active."));
  });

  it("rolls back and shows the error when onMove rejects", async () => {
    const onMove = vi.fn(() => Promise.reject(new Error("Stage change not permitted")));
    render(<KanbanBoard {...common} getAllowedMoves={() => ["done"]} onMove={onMove} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Asha to..." }));
    fireEvent.click((await screen.findAllByRole("menuitem"))[0]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Stage change not permitted");
    expect(within(screen.getByTestId("kanban-col-new")).getByTestId("kanban-card-1")).toBeTruthy();
    expect(within(screen.getByTestId("kanban-col-done")).queryByTestId("kanban-card-1")).toBeNull();
  });
});

describe("GanttTimeline", () => {
  const items = [
    { id: "closed", label: "Cataract course", start: "2026-09-05T00:00:00+05:30", end: "2026-09-15T00:00:00+05:30" },
    { id: "open", label: "IVF cycle", start: "2026-09-20T00:00:00+05:30" },
  ];
  const props = { items, rangeStart: "2026-09-01", rangeEnd: "2026-09-30", timeZone: "Asia/Kolkata", now: NOW };

  it("renders open-ended items as Ongoing without inventing an end date", () => {
    render(<GanttTimeline {...props} />);
    const open = screen.getByTestId("gantt-item-open");
    expect(open.getAttribute("data-open-ended")).toBe("true");
    expect(open.textContent).toContain("Ongoing");
    expect(open.getAttribute("aria-label")).toContain("Ongoing");
    expect(screen.getByTestId("gantt-item-closed").getAttribute("data-open-ended")).toBe("false");
  });

  it("bar is a button that fires onItemClick", () => {
    const onItemClick = vi.fn();
    render(<GanttTimeline {...props} onItemClick={onItemClick} />);
    fireEvent.click(screen.getByTestId("gantt-item-closed"));
    expect(onItemClick).toHaveBeenCalledWith(items[0]);
  });

  it("counts items outside the range rather than dropping them silently", () => {
    render(<GanttTimeline {...props} items={[...items, { id: "old", label: "Old", start: "2026-01-01T00:00:00Z", end: "2026-01-10T00:00:00Z" }]} />);
    expect(screen.getByText("1 outside this range")).toBeTruthy();
  });

  it("uses the compact list on a narrow container", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({ width: 390, height: 600, top: 0, left: 0, right: 390, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    try {
      render(<GanttTimeline {...props} />);
      expect(screen.getByTestId("gantt-list")).toBeTruthy();
      expect(screen.queryByTestId("gantt-grid")).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

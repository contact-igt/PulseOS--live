import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tabs } from "../Tabs";

const items = [
  { key: "a", label: "Alpha", testId: "tab-a" },
  { key: "b", label: "Beta", testId: "tab-b" },
  { key: "c", label: "Gamma", testId: "tab-c" },
];

/** jsdom has no layout: give the strip a width and a (wider) scroll width so overflow is real. */
function overflow(el: HTMLElement, { client, scroll, left }: { client: number; scroll: number; left: number }) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: client });
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scroll });
  el.scrollLeft = left;
  fireEvent.scroll(el);
}

describe("Tabs", () => {
  it.each(["underline", "segmented"] as const)("%s strip scrolls sideways only: overflow-y is hidden so no vertical scrollbar can appear", (variant) => {
    render(<Tabs variant={variant} ariaLabel="Sections" value="a" onChange={() => {}} items={items} />);
    const strip = screen.getByRole("tablist");
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.className).toContain("overflow-y-hidden");
  });

  it("the underline indicator does not use a negative margin (it would overhang the scroll box)", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    for (const t of screen.getAllByRole("tab")) expect(t.className).not.toMatch(/-mb-/);
  });

  it("shows no edge fade while everything fits", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    const strip = screen.getByRole("tablist");
    overflow(strip, { client: 400, scroll: 400, left: 0 });
    expect(strip.getAttribute("data-fade-start")).toBeNull();
    expect(strip.getAttribute("data-fade-end")).toBeNull();
  });

  it("fades the right edge when tabs are cut off, then both edges mid-scroll, then only the left at the end", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    const strip = screen.getByRole("tablist");
    overflow(strip, { client: 300, scroll: 700, left: 0 });
    expect(strip.hasAttribute("data-fade-end")).toBe(true);
    expect(strip.hasAttribute("data-fade-start")).toBe(false);
    overflow(strip, { client: 300, scroll: 700, left: 150 });
    expect(strip.hasAttribute("data-fade-start")).toBe(true);
    expect(strip.hasAttribute("data-fade-end")).toBe(true);
    overflow(strip, { client: 300, scroll: 700, left: 400 });
    expect(strip.hasAttribute("data-fade-start")).toBe(true);
    expect(strip.hasAttribute("data-fade-end")).toBe(false);
  });

  it("keeps the selected tab in view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    scrollIntoView.mockClear();
    rerender(<Tabs variant="underline" value="c" onChange={() => {}} items={items} />);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: "nearest", block: "nearest" }));
  });

  it("supports roving arrow-key selection and exposes tabindex only on the selected tab", () => {
    const onChange = vi.fn();
    render(<Tabs variant="underline" value="a" onChange={onChange} items={items} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(onChange).toHaveBeenCalledWith("c");
  });
});

describe("Tabs: scroll buttons for a mouse (no trackpad needed)", () => {
  it("no buttons while everything fits; ‹ appears only when there is more on the left, › only when there is more on the right", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    const strip = screen.getByRole("tablist");
    overflow(strip, { client: 400, scroll: 400, left: 0 });
    expect(screen.queryByTestId("tabs-scroll-left")).toBeNull();
    expect(screen.queryByTestId("tabs-scroll-right")).toBeNull();
    overflow(strip, { client: 300, scroll: 700, left: 0 });
    expect(screen.queryByTestId("tabs-scroll-left")).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeTruthy();
    overflow(strip, { client: 300, scroll: 700, left: 150 });
    expect(screen.getByRole("button", { name: "Scroll tabs left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scroll tabs right" })).toBeTruthy();
    overflow(strip, { client: 300, scroll: 700, left: 400 });
    expect(screen.queryByTestId("tabs-scroll-right")).toBeNull();
  });

  it("clicking a button scrolls the strip by most of its width in that direction", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    const strip = screen.getByRole("tablist");
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy as unknown as typeof strip.scrollBy;
    overflow(strip, { client: 300, scroll: 700, left: 150 });
    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: 210 }));
    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs left" }));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: -210 }));
  });

  it("the buttons are not extra tab stops (the tabs keep their arrow-key navigation)", () => {
    render(<Tabs variant="underline" value="a" onChange={() => {}} items={items} />);
    overflow(screen.getByRole("tablist"), { client: 300, scroll: 700, left: 150 });
    expect(screen.getByRole("button", { name: "Scroll tabs right" }).getAttribute("tabindex")).toBe("-1");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { QuickCreateMenu } from "../QuickCreateMenu";
import { useFloatingMenu } from "../useFloatingMenu";

afterEach(cleanup);

const items = [
  { key: "lead", label: "Add Lead", onClick: vi.fn() },
  { key: "appt", label: "Add Appointment", onClick: vi.fn() },
  { key: "task", label: "Add Task", onClick: vi.fn() },
];

/** A second top-bar menu (stands in for the account menu), built on the same hook. */
function AccountMenu() {
  const [open, setOpen] = useState(false);
  const m = useFloatingMenu("profile", open, setOpen);
  return (
    <div ref={m.containerRef}>
      <button ref={m.triggerRef} type="button" onClick={() => setOpen((v) => !v)} data-testid="profile-trigger">Account</button>
      {open && (
        <div role="menu" onKeyDown={m.onMenuKeyDown} data-testid="profile-menu">
          <button role="menuitem" type="button">Log out</button>
        </div>
      )}
    </div>
  );
}

describe("floating menus (Create, account)", () => {
  it("the Create menu is a floating surface: solid-ish, not glass", () => {
    render(<QuickCreateMenu items={items} />);
    fireEvent.click(screen.getByTestId("quick-create-button"));
    const cls = screen.getByTestId("quick-create-menu").className;
    expect(cls).toContain("floating");
    expect(cls).not.toMatch(/glass|bg-white\/\d/);
    expect(cls).toContain("z-(--z-dropdown)"); // the shared layer, not a raw number
  });

  it("opening the account menu closes Create, and opening Create closes the account menu", () => {
    render(<><QuickCreateMenu items={items} /><AccountMenu /></>);
    fireEvent.click(screen.getByTestId("quick-create-button"));
    expect(screen.getByTestId("quick-create-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("profile-trigger"));
    expect(screen.queryByTestId("quick-create-menu")).toBeNull();
    expect(screen.getByTestId("profile-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("quick-create-button"));
    expect(screen.queryByTestId("profile-menu")).toBeNull();
    expect(screen.getByTestId("quick-create-menu")).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to its button", () => {
    render(<QuickCreateMenu items={items} />);
    const trigger = screen.getByTestId("quick-create-button");
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("quick-create-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a click outside closes it; a click inside the open menu does not", () => {
    render(<><QuickCreateMenu items={items} /><p data-testid="elsewhere">page</p></>);
    fireEvent.click(screen.getByTestId("quick-create-button"));
    fireEvent.mouseDown(screen.getByTestId("quick-create-menu"));
    expect(screen.getByTestId("quick-create-menu")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("elsewhere"));
    expect(screen.queryByTestId("quick-create-menu")).toBeNull();
  });

  it("arrow keys, Home and End move between the menu items (wrapping)", () => {
    render(<QuickCreateMenu items={items} />);
    fireEvent.click(screen.getByTestId("quick-create-button"));
    const [a, b, c] = ["lead", "appt", "task"].map((k) => screen.getByTestId(`quick-create-${k}`));
    a!.focus();
    fireEvent.keyDown(a!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b!, { key: "End" });
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(c);
  });

  it("choosing an item runs it and closes the menu", () => {
    const onClick = vi.fn();
    render(<QuickCreateMenu items={[{ key: "lead", label: "Add Lead", onClick }]} />);
    fireEvent.click(screen.getByTestId("quick-create-button"));
    fireEvent.click(screen.getByTestId("quick-create-lead"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("quick-create-menu")).toBeNull();
  });
});

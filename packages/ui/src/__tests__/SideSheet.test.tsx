import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SideSheet } from "../SideSheet";

describe("SideSheet", () => {
  it("is a labelled modal dialog with a title, content and footer, and a visible close control", () => {
    render(
      <SideSheet title="Edit field" subtitle="Budget" onClose={() => {}} footer={<button type="button">Save</button>} testId="sheet">
        <label>
          Label <input defaultValue="Budget" />
        </label>
      </SideSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit field" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Budget", { selector: "p" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByTestId("sheet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Edit field" })).toBeTruthy();
  });

  it("moves focus inside, closes on Escape, the close button and the backdrop", () => {
    const onClose = vi.fn();
    render(
      <SideSheet title="Edit field" onClose={onClose}>
        <input aria-label="Label" />
      </SideSheet>,
    );
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close Edit field" }));
    fireEvent.click(screen.getByTestId("side-sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("scrolls its body, not the page: the footer stays pinned (min-h-0 body inside a flex column)", () => {
    render(
      <SideSheet title="T" onClose={() => {}} footer={<span>footer</span>}>
        <p>body</p>
      </SideSheet>,
    );
    expect(screen.getByTestId("side-sheet-body").className).toMatch(/overflow-y-auto/);
    expect(screen.getByTestId("side-sheet-body").className).toMatch(/min-h-0/);
  });
});

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDialogFocus } from "../useDialogFocus";

function Harness() {
  const ref = useDialogFocus<HTMLDivElement>(true, () => {});
  return (
    <>
      <button type="button">Behind</button>
      <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>
    </>
  );
}

describe("useDialogFocus", () => {
  it("pulls focus back into the dialog when an action removed the focused control (focus fell to <body>)", () => {
    render(<Harness />);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });
});

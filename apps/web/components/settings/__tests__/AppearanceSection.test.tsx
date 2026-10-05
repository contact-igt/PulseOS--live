import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppearanceSection } from "../AppearanceSection";

// Settings > Appearance: three named styles, a live preview that follows the choice at once, and the existing save pattern
// (Save persists per hospital, Cancel restores, a failed save keeps the choice and says so).

function sessionOf(surfaceStyle?: string) {
  return { user: { id: "u1", role: "HOSPITAL_ADMIN", timezone: "Asia/Kolkata", ...(surfaceStyle ? { surfaceStyle } : {}) } };
}
function setup(opts: { saved?: string; put?: () => Response | Promise<Response>; afterSave?: string } = {}) {
  let current = opts.saved;
  const calls: { method: string; url: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body as string | undefined });
      if (url.endsWith("/appearance") && method === "PUT") {
        const res = opts.put ? await opts.put() : new Response(JSON.stringify({ surfaceStyle: JSON.parse(init!.body as string).surfaceStyle }), { status: 200, headers: { "content-type": "application/json" } });
        if (res.ok) current = JSON.parse(init!.body as string).surfaceStyle;
        return res;
      }
      return new Response(JSON.stringify(sessionOf(current)), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["session"], sessionOf(current));
  render(
    <QueryClientProvider client={client}>
      <AppearanceSection />
    </QueryClientProvider>,
  );
  return { calls };
}
const preview = () => screen.getByTestId("appearance-preview");
const radio = (k: string) => screen.getByTestId(`appearance-option-${k}`) as HTMLInputElement;

afterEach(() => vi.unstubAllGlobals());

describe("Settings > Appearance", () => {
  it("offers exactly three named styles, in plain words (no opacity numbers, CSS or blur)", () => {
    setup();
    expect(screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)).toEqual(["airy", "balanced", "solid"]);
    const text = screen.getByTestId("appearance-section").textContent ?? "";
    expect(text).toMatch(/Airy Glass/);
    expect(text).toMatch(/Balanced/);
    expect(text).toMatch(/Solid/);
    expect(text).not.toMatch(/opacity|alpha|rgba|blur|css|\d+\s?%/i);
  });

  it("a hospital with no saved style shows Balanced, and Save/Cancel start disabled", () => {
    setup();
    expect(radio("balanced").checked).toBe(true);
    expect(preview().getAttribute("data-surface")).toBe("balanced");
    expect((screen.getByTestId("appearance-save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("appearance-cancel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the preview follows the choice immediately, with nothing saved yet", () => {
    const { calls } = setup({ saved: "balanced" });
    fireEvent.click(radio("airy"));
    expect(preview().getAttribute("data-surface")).toBe("airy");
    fireEvent.click(radio("solid"));
    expect(preview().getAttribute("data-surface")).toBe("solid");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect((screen.getByTestId("appearance-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the preview shows a top bar, an open menu, a summary strip, a control, a list row and a sheet", () => {
    setup();
    for (const id of ["preview-topbar", "preview-menu", "preview-select", "preview-create", "preview-row", "preview-sheet"]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId("preview-menu").className).toContain("floating");
  });

  it("the preview adds no tab stops and is hidden from assistive technology", () => {
    setup();
    expect(preview().getAttribute("aria-hidden")).toBe("true");
    expect(preview().hasAttribute("inert")).toBe(true);
  });

  it("Cancel puts the saved style back, in the controls and in the preview", () => {
    setup({ saved: "balanced" });
    fireEvent.click(radio("solid"));
    fireEvent.click(screen.getByTestId("appearance-cancel"));
    expect(radio("balanced").checked).toBe(true);
    expect(preview().getAttribute("data-surface")).toBe("balanced");
    expect((screen.getByTestId("appearance-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Save stores the chosen style for the hospital, then reads it back from the server", async () => {
    const { calls } = setup({ saved: "balanced" });
    fireEvent.click(radio("solid"));
    fireEvent.click(screen.getByTestId("appearance-save"));
    await waitFor(() => expect(screen.getByTestId("appearance-notice")).toBeTruthy());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ surfaceStyle: "solid" });
    expect(radio("solid").checked).toBe(true);
    expect((screen.getByTestId("appearance-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed save keeps the selection (and the preview), says so inline, and can be retried", async () => {
    const { calls } = setup({ saved: "balanced", put: () => new Response("{}", { status: 500 }) });
    fireEvent.click(radio("airy"));
    fireEvent.click(screen.getByTestId("appearance-save"));
    const err = await screen.findByTestId("appearance-error");
    expect(err.textContent).toMatch(/could not save/i);
    expect(radio("airy").checked).toBe(true);
    expect(preview().getAttribute("data-surface")).toBe("airy");
    expect((screen.getByTestId("appearance-save") as HTMLButtonElement).disabled).toBe(false);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});

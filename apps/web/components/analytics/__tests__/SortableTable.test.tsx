import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SortableTable, type SortColumn } from "../SortableTable";

interface Row { id: string; name: string; n: number }
const rows: Row[] = [{ id: "a", name: "Beta", n: 2 }, { id: "b", name: "Alpha", n: 9 }, { id: "c", name: "Gamma", n: 5 }];
const cols: SortColumn<Row>[] = [
  { key: "name", label: "Name", get: (r) => r.name, align: "left", rowHeader: true },
  { key: "n", label: "Count", get: (r) => r.n, align: "right" },
];
const names = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("rowheader")[0]!.textContent);

describe("SortableTable", () => {
  it("sorts by the default column and marks it with aria-sort", () => {
    render(<SortableTable caption="Things" rows={rows} columns={cols} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "desc" }} />);
    expect(names()).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(screen.getByRole("columnheader", { name: /Count/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("clicking a header sorts ascending first, then flips; the header is a real button", () => {
    render(<SortableTable caption="Things" rows={rows} columns={cols} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "desc" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("puts empty values last in either direction", () => {
    const withNull = [...rows, { id: "d", name: "Delta", n: null as unknown as number }];
    render(<SortableTable caption="Things" rows={withNull} columns={cols} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "asc" }} />);
    expect(names().at(-1)).toBe("Delta");
    fireEvent.click(screen.getByRole("button", { name: /Count/ }));
    expect(names().at(-1)).toBe("Delta");
  });

  it("a row can drill: Enter / click calls onRowClick with that row", () => {
    const onRowClick = vi.fn();
    render(<SortableTable caption="Things" rows={rows} columns={cols} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "desc" }} onRowClick={onRowClick} rowLabel={(r) => `Filter to ${r.name}`} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter to Gamma" }));
    expect(onRowClick).toHaveBeenCalledWith(rows[2]);
  });

  it("is captioned for screen readers and has no sort buttons on unsortable columns", () => {
    render(<SortableTable caption="Things by name" rows={rows} columns={[{ ...cols[0]!, sortable: false }, cols[1]!]} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "desc" }} />);
    expect(screen.getByRole("table", { name: "Things by name" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Name/ })).toBeNull();
  });
});

describe("SortableTable — rows that cannot drill", () => {
  it("renders plain text (no dead button) for a row that is not drillable", () => {
    const onRowClick = vi.fn();
    render(<SortableTable caption="Things" rows={rows} columns={cols} rowKey={(r) => r.id} defaultSort={{ key: "n", dir: "desc" }} onRowClick={onRowClick} rowLabel={(r) => `Filter to ${r.name}`} isDrillable={(r) => r.id !== "b"} />);
    expect(screen.queryByRole("button", { name: "Filter to Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filter to Gamma" })).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});

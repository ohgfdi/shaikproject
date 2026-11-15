/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataTable, type DataColumn, type DataRow } from "@/components/ui/table";

const columns: DataColumn[] = [
  { key: "region", label: "Region" },
  { key: "revenue", label: "Revenue", format: "number" },
];

function rows(n: number): DataRow[] {
  return Array.from({ length: n }, (_, i) => ["R" + i, i * 100] as DataRow);
}

describe("DataTable", () => {
  it("renders headers and body rows", () => {
    render(<DataTable columns={columns} rows={rows(3)} />);
    expect(screen.getByRole("columnheader", { name: "Region" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Revenue" })).toBeInTheDocument();
    expect(screen.getByText("R0")).toBeInTheDocument();
    expect(screen.getByText("R2")).toBeInTheDocument();
  });

  it("formats number cells with the requested locale style", () => {
    render(<DataTable columns={columns} rows={[["x", 1234.5]]} numStyle="dot" />);
    expect(screen.getByText("1.234,5")).toBeInTheDocument();
  });

  it("paginates when a pageSize is given and smaller than row count", async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} rows={rows(50)} pageSize={10} />);
    expect(screen.getByText("R0")).toBeInTheDocument();
    expect(screen.getByText("R9")).toBeInTheDocument();
    expect(screen.queryByText("R10")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("R10")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("R0")).toBeInTheDocument();
  });

  it("shows an empty message when there are no rows", () => {
    render(<DataTable columns={columns} rows={[]} />);
    expect(screen.getByText("No rows to show.")).toBeInTheDocument();
  });
});

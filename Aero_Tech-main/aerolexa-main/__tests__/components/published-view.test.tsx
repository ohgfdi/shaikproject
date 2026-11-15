/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";

import { PublishedNotebookView } from "@/components/notebook/published-view";
import type { NotebookCell, NotebookCellOutput, PublishedNotebook } from "@/lib/types";

function publishedNotebook(cells: NotebookCell[]): PublishedNotebook {
  return {
    id: "nbk_1",
    title: "Quarterly review",
    datasetName: "revenue.csv",
    accessMode: "public",
    publishedAt: null,
    cells,
  };
}

const tableCell: NotebookCell = {
  id: "cell_table",
  kind: "code",
  content: "df.head()",
  output: {
    type: "table",
    title: "Revenue by region",
    columns: [
      { key: "region", label: "Region" },
      { key: "revenue", label: "Revenue", format: "number" },
    ],
    rows: [
      ["North", 1200],
      ["South", 800],
    ],
  },
};

describe("PublishedNotebookView", () => {
  it("renders table output columns and rows without type assertions", () => {
    render(<PublishedNotebookView app={publishedNotebook([tableCell])} />);

    expect(screen.getByRole("columnheader", { name: "Region" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Revenue" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "North" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1200" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "800" })).toBeInTheDocument();
  });

  it("falls back instead of crashing when a stored table output is malformed", () => {
    const malformed: NotebookCell = {
      id: "cell_broken",
      kind: "code",
      content: "df.head()",
      output: { type: "table", title: "Broken snapshot" } as NotebookCellOutput,
    };

    render(<PublishedNotebookView app={publishedNotebook([malformed])} />);

    expect(screen.getByText("Output rendered")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

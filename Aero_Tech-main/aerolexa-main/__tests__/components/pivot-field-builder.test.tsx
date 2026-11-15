/** @jest-environment jsdom */
/**
 * Component verification of the pivot field builder (P8/E17).
 *
 * Drives the REAL component and asserts the well state it produces is exactly
 * the payload contract of `POST /api/datasets/:id/pivot` — every mutation
 * goes through the pivot-grid engine (addField / removeField /
 * setValueAggregation), so the invariant "a field lives in exactly one well"
 * and the aggregation gate (no sum of a text column) are enforced here, not
 * just in the engine's unit test.
 *
 * jsdom note: dispatching dragStart on a chip flushes React state, which
 * suppresses the *synthetic* drop that follows (the native event still
 * arrives). The drag tests therefore start the drag on the well itself — the
 * drop handler under test is the component's real one, keyed by
 * dataTransfer.getData exactly as in a browser. Click-to-place (the
 * keyboard-accessible path) covers the same engine calls without the quirk.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { PivotFieldBuilder } from "@/components/pivot/pivot-field-builder";
import { pivotRequestBody, type PivotField, type PivotFieldState } from "@/lib/engine/pivot-grid";

const FIELDS: PivotField[] = [
  { name: "region", type: "string" },
  { name: "product", type: "string" },
  { name: "revenue", type: "number" },
  { name: "quantity", type: "number" },
  { name: "order_date", type: "date" },
];

/** Controlled harness so the test sees the same state the dashboard would. */
function Harness({ onApply }: { onApply?: (s: PivotFieldState) => void }) {
  const [state, setState] = useState<PivotFieldState>({ rows: [], columns: [], values: [] });
  return (
    <>
      <output data-testid="state">{JSON.stringify(state)}</output>
      <PivotFieldBuilder fields={FIELDS} value={state} onChange={setState} onApply={onApply} />
    </>
  );
}

const currentState = (): PivotFieldState => JSON.parse(screen.getByTestId("state").textContent ?? "{}");

/** Drop `field` into `well` through the component's real onDrop handler. */
function dropFieldIntoWell(field: string, well: string) {
  const wellTarget = screen.getByRole("list", { name: `${well} well` });
  const dt = { setData: jest.fn(), getData: jest.fn(() => field), dropEffect: "" };
  fireEvent.dragStart(wellTarget, { dataTransfer: dt });
  fireEvent.dragOver(wellTarget, { dataTransfer: dt });
  fireEvent.drop(wellTarget, { dataTransfer: dt });
}

describe("PivotFieldBuilder", () => {
  it("click-to-place a numeric field into Values with a default sum", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTitle(/^revenue /));
    expect(currentState().values).toEqual([{ column: "revenue", aggregation: "sum" }]);
  });

  it("click-to-place a non-numeric field into Rows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTitle(/^region /));
    expect(currentState().rows).toEqual(["region"]);
  });

  it("drag-drop places a field into the well it was dropped on", () => {
    render(<Harness />);
    dropFieldIntoWell("revenue", "values");
    expect(currentState().values).toEqual([{ column: "revenue", aggregation: "sum" }]);
  });

  it("drag-drop places a text field into Rows", () => {
    render(<Harness />);
    dropFieldIntoWell("region", "rows");
    expect(currentState().rows).toEqual(["region"]);
  });

  it("moves a field between wells, never keeping it in two", () => {
    render(<Harness />);
    dropFieldIntoWell("region", "rows");
    expect(currentState().rows).toEqual(["region"]);
    // Drop the SAME field into columns — the engine must remove it from rows.
    dropFieldIntoWell("region", "columns");
    const s = currentState();
    expect(s.rows).toEqual([]);
    expect(s.columns).toEqual(["region"]);
  });

  it("switches a value's aggregation in place", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTitle(/^revenue /));
    await user.selectOptions(screen.getByLabelText("Aggregation for revenue"), "avg");
    expect(currentState().values).toEqual([{ column: "revenue", aggregation: "avg" }]);
  });

  it("never offers sum/avg for a text column in the aggregation menu", async () => {
    render(<Harness />);
    // A string column placed into Values defaults to count…
    dropFieldIntoWell("region", "values");
    expect(currentState().values).toEqual([{ column: "region", aggregation: "count" }]);
    // …and the menu only offers aggregations legal for a string column.
    const menu = screen.getByLabelText("Aggregation for region");
    const options = Array.from(menu.querySelectorAll("option")).map((o) => o.value);
    expect(options).toEqual(["count", "min", "max"]);
    expect(options).not.toContain("sum");
  });

  it("removes a chip from its well back to the pool", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    dropFieldIntoWell("product", "rows");
    expect(currentState().rows).toEqual(["product"]);
    await user.click(screen.getByLabelText("Remove product from rows"));
    expect(currentState().rows).toEqual([]);
    expect(screen.getByTitle(/^product /)).toBeInTheDocument();
  });

  it("refuses to apply an incomplete configuration (engine validation)", async () => {
    const user = userEvent.setup();
    const onApply = jest.fn();
    render(<Harness onApply={onApply} />);
    // No rows and no values yet: the engine refuses and the builder shows why.
    expect(screen.getByText(/Add at least one row field/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add pivot to dashboard/ })).toBeNull();

    dropFieldIntoWell("region", "rows");
    expect(screen.getByText(/Add at least one value field/)).toBeInTheDocument();

    dropFieldIntoWell("revenue", "values");
    await user.click(screen.getByRole("button", { name: /Add pivot to dashboard/ }));
    expect(onApply).toHaveBeenCalledWith({
      rows: ["region"],
      columns: [],
      values: [{ column: "revenue", aggregation: "sum" }],
    });
  });

  it("produces a payload the pivot route accepts (pivotRequestBody parity)", () => {
    render(<Harness />);
    dropFieldIntoWell("region", "rows");
    dropFieldIntoWell("order_date", "columns");
    dropFieldIntoWell("revenue", "values");
    const request = pivotRequestBody(currentState());
    expect(request.error).toBeUndefined();
    expect(request).toEqual({
      rows: ["region"],
      columns: ["order_date"],
      values: [{ column: "revenue", aggregation: "sum" }],
    });
  });
});

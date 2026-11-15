# published-notebook/page.tsx type error — cell.output.columns

> **Status: resolved.** The renderer moved to `components/notebook/published-view.tsx`
> and now uses `isTableOutput` / `isConditionalTableOutput` from
> `lib/engine/notebook-output.ts`; the inline `.columns` access and the
> redundant narrowing check described below no longer exist. Regression tests
> live in `__tests__/components/published-view.test.tsx` and
> `__tests__/unit/notebook-output.test.ts`.

## Issue

Type error at `app/(app)/published-notebook/page.tsx:197` where `cell.output.columns` is accessed. The `NotebookCellOutput` type in `lib/types.ts:508-529` defines `columns` only for the `"table"` variant of the discriminated union, but TypeScript does not narrow correctly in the component's render logic.

## Symptom

When rendering a published notebook with table-output cells, the TypeScript compiler reports that `.columns` does not exist on the type of `cell.output`, or the rows/columns data structure is mismatched at runtime.

## Root Cause

The `NotebookCellOutput` type uses `type` as a discriminant:

```tsx
export type NotebookCellOutput = (
  | {
      type: "error";
      message: string;
    }
  | {
      type: "note";
      title: string;
      detail: string;
    }
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      image: { mimeType: "image/png"; data: string };
    }
  | {
      type: "table";
      title: string;
      columns: { key: string; label: string; format?: "number" | "pct" | "date" | "text" }[];
      rows: (string | number | null)[][];
    }
  | { type: "stats"; title: string; stats: { label: string; value: string; hint?: string }[] }
  | { type: "chart"; title: string; chart: ChartSpec }
) & {
  kernel?: "pyodide" | "dsl";
};
```

However, the render logic in `published-notebook/page.tsx` does not reliably trigger TypeScript's discriminated-union narrowing. The `cell.output?.type === "table"` check exists but the narrowed type is lost before `.columns` is accessed, or the type assertion is incomplete.

## Current Code (problematic section)

```tsx
{notebook.cells
  .filter((c) => c.output)
  .map((cell, i) => {
    if (cell.output?.type === "error") { ... }
    if (cell.output?.type === "stats") { ... }
    if (cell.output?.type === "table") {
      return (
        <div>
          <table>
            <thead>
              {cell.output.columns.map((c) => (  ← error: TypeScript cannot verify .columns exists
                <th key={c.key}>{c.label}</th>
              ))}
            </thead>
            <tbody>{cell.output?.type === "table" && (...}
          </table>
        </div>
      );
    }
    ...
  })}
```

Note the redundant `cell.output?.type === "table" &&` inside `<tbody>` — this suggests the developer knew the narrowing was unreliable.

## Recommended Fix

**Option 1 — Add type assertion (minimal fix):**

```tsx
if (cell.output?.type === "table") {
  return (
    <div>
      <table>
        <thead>
          {(cell.output as { columns: { key: string; label: string }[] }).columns.map((c) => (
            <th key={c.key}>{c.label}</th>
          ))}
        </thead>
        <tbody>
          {(cell.output as { rows: any[][]; columns: any[] }).rows.map((row, r) => (
            ...
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Option 2 — Refactor with proper type guard:**

```tsx
function isTableOutput(output: NotebookCellOutput | null): output is { type: "table"; columns: {...}; rows: ... } {
  return output?.type === "table";
}

// Usage:
{cell.output && isTableOutput(cell.output) && (
  ...
  {cell.output.columns.map(...)}
)}
```

**Option 3 — Ensure the type definition is correct and import it:**

Verify that `lib/types.ts` exports `NotebookCellOutput` correctly and that `published-notebook/page.tsx` imports it for proper narrowing.

## Verification

After the fix, run `npx tsc --noEmit` to confirm no type errors remain for `published-notebook/page.tsx`, and run the existing unit tests to ensure the published notebook renders correctly with table outputs.

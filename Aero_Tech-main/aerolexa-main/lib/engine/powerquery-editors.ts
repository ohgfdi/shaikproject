/**
 * Schema-driven step editors for the Power Query studio (Gap ⑤).
 *
 * One FIELD descriptor per editable parameter drives the whole editor UI:
 * which control renders, which columns populate its dropdown, and how the
 * PQStep is patched on change. Adding a step kind to the engine's palette
 * needs only a new entry in STEP_EDITORS — no bespoke dialog code.
 */

export interface FieldOption {
  value: string;
  label: string;
}

export type EditorField =
  | { key: string; label: string; control: "column"; required?: boolean }
  | { key: string; label: string; control: "columns"; required?: boolean }
  | { key: string; label: string; control: "text"; placeholder?: string }
  | { key: string; label: string; control: "number"; min?: number; max?: number }
  | { key: string; label: string; control: "select"; options: FieldOption[] }
  | { key: string; label: string; control: "value" } // free scalar (find/replace)
  | { key: string; label: string; control: "aggSpec" }; // group-by aggregation rows

/** Editor schema for one step kind. `fields` patch the step in order. */
export interface StepEditorSpec {
  kind: string;
  title: string;
  fields: EditorField[];
}

const FILTER_OPS: FieldOption[] = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "not equals" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "notContains", label: "does not contain" },
  { value: "beginsWith", label: "begins with" },
  { value: "endsWith", label: "ends with" },
  { value: "isEmpty", label: "is empty" },
  { value: "isNotEmpty", label: "is not empty" },
];

const AGG_FNS: FieldOption[] = [
  { value: "sum", label: "sum" },
  { value: "avg", label: "average" },
  { value: "count", label: "count" },
  { value: "countDistinct", label: "distinct count" },
  { value: "min", label: "min" },
  { value: "max", label: "max" },
  { value: "median", label: "median" },
  { value: "stddev", label: "std dev" },
  { value: "first", label: "first" },
  { value: "last", label: "last" },
];

const COL_TYPES: FieldOption[] = [
  { value: "number", label: "number" },
  { value: "string", label: "text" },
  { value: "boolean", label: "true/false" },
  { value: "date", label: "date" },
];

/**
 * The whole editor surface, data-driven. Keys map 1:1 onto PQStep properties.
 */
export const STEP_EDITORS: Record<string, StepEditorSpec> = {
  removeColumns: {
    kind: "removeColumns",
    title: "Remove columns",
    fields: [{ key: "columns", label: "Columns", control: "columns", required: true }],
  },
  removeDuplicates: {
    kind: "removeDuplicates",
    title: "Remove duplicates",
    fields: [{ key: "columns", label: "Key columns (empty = all)", control: "columns" }],
  },
  renameColumn: {
    kind: "renameColumn",
    title: "Rename column",
    fields: [
      { key: "from", label: "Column", control: "column", required: true },
      { key: "to", label: "New name", control: "text" },
    ],
  },
  changeType: {
    kind: "changeType",
    title: "Change type",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      { key: "to", label: "New type", control: "select", options: COL_TYPES },
      {
        key: "errors",
        label: "On error",
        control: "select",
        options: [
          { value: "keep", label: "keep value" },
          { value: "null", label: "set null" },
        ],
      },
    ],
  },
  filterRows: {
    kind: "filterRows",
    title: "Filter rows",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      { key: "op", label: "Condition", control: "select", options: FILTER_OPS },
      { key: "value", label: "Value", control: "value" },
    ],
  },
  sortRows: {
    kind: "sortRows",
    title: "Sort",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      {
        key: "direction",
        label: "Order",
        control: "select",
        options: [
          { value: "asc", label: "ascending" },
          { value: "desc", label: "descending" },
        ],
      },
    ],
  },
  replaceValues: {
    kind: "replaceValues",
    title: "Replace values",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      { key: "find", label: "Find", control: "value" },
      { key: "replace", label: "Replace with", control: "value" },
    ],
  },
  fillDown: {
    kind: "fillDown",
    title: "Fill down",
    fields: [{ key: "column", label: "Column", control: "column", required: true }],
  },
  trimText: {
    kind: "trimText",
    title: "Trim text",
    fields: [{ key: "column", label: "Column", control: "column", required: true }],
  },
  uppercase: {
    kind: "uppercase",
    title: "UPPERCASE",
    fields: [{ key: "column", label: "Column", control: "column", required: true }],
  },
  lowercase: {
    kind: "lowercase",
    title: "lowercase",
    fields: [{ key: "column", label: "Column", control: "column", required: true }],
  },
  splitColumn: {
    kind: "splitColumn",
    title: "Split column",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      { key: "separator", label: "Separator", control: "text" },
    ],
  },
  mergeColumns: {
    kind: "mergeColumns",
    title: "Merge columns",
    fields: [
      { key: "columns", label: "Columns", control: "columns", required: true },
      { key: "separator", label: "Separator", control: "text" },
      { key: "name", label: "New column name", control: "text" },
    ],
  },
  groupBy: {
    kind: "groupBy",
    title: "Group by",
    fields: [
      { key: "groupBy", label: "Group by column", control: "column", required: true },
      { key: "aggregations", label: "Aggregations", control: "aggSpec" },
    ],
  },
  addCustomColumn: {
    kind: "addCustomColumn",
    title: "Custom column",
    fields: [
      { key: "name", label: "Column name", control: "text" },
      { key: "expression", label: "Expression", control: "text" },
    ],
  },
  addIndexColumn: {
    kind: "addIndexColumn",
    title: "Index column",
    fields: [
      { key: "name", label: "Column name", control: "text" },
      { key: "start", label: "Start at", control: "number", min: 0 },
    ],
  },
  pivot: {
    kind: "pivot",
    title: "Pivot",
    fields: [
      { key: "attributeColumn", label: "Attribute column", control: "column", required: true },
      { key: "valueColumn", label: "Value column", control: "column", required: true },
      { key: "aggregation", label: "Aggregate with", control: "select", options: AGG_FNS },
    ],
  },
  topN: {
    kind: "topN",
    title: "Top N",
    fields: [
      { key: "column", label: "Rank by (empty = row count)", control: "column" },
      { key: "n", label: "N", control: "number", min: 1 },
      {
        key: "direction",
        label: "Direction",
        control: "select",
        options: [
          { value: "top", label: "top" },
          { value: "bottom", label: "bottom" },
        ],
      },
    ],
  },
  keepRange: {
    kind: "keepRange",
    title: "Keep range",
    fields: [
      { key: "column", label: "Column", control: "column", required: true },
      { key: "min", label: "Min", control: "number" },
      { key: "max", label: "Max", control: "number" },
    ],
  },
  // removeBlankRows and unpivot need no parameters (or use fixed defaults).
};

/** Lookup used by the studio: which fields does this step expose? */
export function editorFor(kind: string): StepEditorSpec | null {
  return STEP_EDITORS[kind] ?? null;
}

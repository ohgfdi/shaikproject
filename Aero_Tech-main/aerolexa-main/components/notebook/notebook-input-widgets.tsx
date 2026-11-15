"use client";

/**
 * Notebook input widgets (Hex-style data-app controls).
 *
 * Each control binds a named variable; code cells reference it with
 * {{variable}} and re-run when the value changes. The published-app view
 * renders the same controls in disabled mode against the snapshot outputs.
 */

import { useId } from "react";

import type { NotebookWidget, NotebookWidgetValue } from "@/lib/types";
import { cn } from "@/lib/utils";

const inputClass =
  "h-9 rounded-md border border-line bg-surface px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-focus/60 disabled:opacity-60";

export interface DateRangePickerProps {
  variableName: string;
  onChange: (value: { min: string; max: string } | null) => void;
  value?: { min: string | number; max: string | number } | null;
  disabled?: boolean;
}

export function DateRangePicker({ variableName, onChange, value, disabled }: DateRangePickerProps) {
  const id = useId();
  const min = typeof value?.min === "string" ? value.min : "";
  const max = typeof value?.max === "string" ? value.max : "";
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={`${id}-min`} className="sr-only">
        {variableName} start date
      </label>
      <input
        id={`${id}-min`}
        type="date"
        className={inputClass}
        value={min}
        disabled={disabled}
        onChange={(e) => onChange({ min: e.target.value, max })}
      />
      <span className="text-caption text-muted">→</span>
      <label htmlFor={`${id}-max`} className="sr-only">
        {variableName} end date
      </label>
      <input
        id={`${id}-max`}
        type="date"
        className={inputClass}
        value={max}
        disabled={disabled}
        onChange={(e) => onChange({ min, max: e.target.value })}
      />
    </div>
  );
}

export interface DropdownSelectProps {
  variableName: string;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  value?: string | null;
  disabled?: boolean;
}

export function DropdownSelect({ variableName, options, onChange, value, disabled }: DropdownSelectProps) {
  const id = useId();
  return (
    <select
      id={id}
      aria-label={variableName}
      className={inputClass}
      value={value ?? options[0]?.value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface TextInputProps {
  variableName: string;
  onChange: (value: string | null) => void;
  value?: string | null;
  disabled?: boolean;
}

export function TextInput({ variableName, onChange, value, disabled }: TextInputProps) {
  const id = useId();
  return (
    <input
      id={id}
      type="text"
      aria-label={variableName}
      className={inputClass}
      value={value ?? ""}
      disabled={disabled}
      placeholder={`Enter ${variableName}…`}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export interface SliderInputProps {
  variableName: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number | null) => void;
  value?: number | null;
  disabled?: boolean;
}

export function SliderInput({ variableName, min, max, step = 1, onChange, value, disabled }: SliderInputProps) {
  const id = useId();
  const current = typeof value === "number" ? value : min;
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="range"
        aria-label={variableName}
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40 accent-accent"
      />
      <span className="w-14 text-right text-sm tabular-nums text-foreground">{current}</span>
    </div>
  );
}

/** Number input with stepper (used by the "number" widget kind). */
export interface NumberInputProps {
  variableName: string;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number | null) => void;
  value?: number | null;
  disabled?: boolean;
}

export function NumberInput({ variableName, min, max, step = 1, onChange, value, disabled }: NumberInputProps) {
  const id = useId();
  return (
    <input
      id={id}
      type="number"
      aria-label={variableName}
      className={cn(inputClass, "w-32")}
      min={min}
      max={max}
      step={step}
      value={typeof value === "number" ? value : ""}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value === "" ? null : Number(e.target.value);
        onChange(Number.isFinite(next as number) ? next : null);
      }}
    />
  );
}

export interface NotebookWidgetControlProps {
  widget: NotebookWidget;
  onChange: (value: NotebookWidgetValue) => void;
  disabled?: boolean;
}

/** Dispatcher that renders the right control for a widget descriptor. */
export function NotebookWidgetControl({ widget, onChange, disabled }: NotebookWidgetControlProps) {
  const common = { variableName: widget.variable, disabled };
  switch (widget.kind) {
    case "text":
      return (
        <TextInput
          {...common}
          value={typeof widget.value === "string" ? widget.value : null}
          onChange={(v) => onChange(v)}
        />
      );
    case "number":
      return (
        <NumberInput
          {...common}
          min={widget.min}
          max={widget.max}
          step={widget.step ?? 1}
          value={typeof widget.value === "number" ? widget.value : null}
          onChange={(v) => onChange(v)}
        />
      );
    case "dropdown":
      return (
        <DropdownSelect
          {...common}
          options={widget.options ?? [{ value: "A", label: "A" }]}
          value={typeof widget.value === "string" ? widget.value : null}
          onChange={(v) => onChange(v)}
        />
      );
    case "date-range":
      return (
        <DateRangePicker
          {...common}
          value={typeof widget.value === "object" && widget.value !== null ? widget.value : null}
          onChange={(v) => onChange(v)}
        />
      );
  }
}

/** Human label for a widget kind (used in the “add widget” menu). */
export const WIDGET_KIND_LABELS: Record<NotebookWidget["kind"], string> = {
  text: "Text input",
  number: "Number / slider",
  dropdown: "Dropdown select",
  "date-range": "Date range",
};

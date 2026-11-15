"use client";

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

function fieldClasses(hasError?: boolean) {
  // `mat-well` makes the control a concave surface: the key light's occlusion
  // falls inward from the top edge and bounce light returns from the bottom,
  // which is what makes an input read as pressable rather than painted on.
  return cn(
    "mat-well w-full rounded-md border border-line bg-surface px-3 text-sm text-foreground placeholder:text-muted/70",
    "focus:outline-none focus:ring-2 focus:ring-focus/60 focus:border-focus/50",
    "disabled:cursor-not-allowed disabled:opacity-50 transition-shadow",
    hasError && "border-danger/70 focus:ring-danger/40 focus:border-danger",
  );
}

interface FieldShellProps {
  label?: ReactNode;
  htmlFor?: string;
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, helper, error, required, children, className }: FieldShellProps) {
  const autoId = useId();

  // Resolve the id the <label> points at. When the caller did not pass one
  // explicitly, derive it from the wrapped control and, failing that, generate
  // one and inject it into the control so the association is always real.
  const first = Children.toArray(children)[0];
  const childId = isValidElement(first) ? ((first.props as { id?: string } | null)?.id ?? undefined) : undefined;
  const id = htmlFor ?? childId ?? autoId;

  const labelled = Children.map(children, (child, index) => {
    if (index !== 0 || !isValidElement<{ id?: string }>(child)) return child;
    if ((child.props as { id?: string } | null)?.id) return child;
    return cloneElement(child as ReactElement<{ id?: string }>, { id });
  });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
          {required && (
            <span aria-hidden className="ml-0.5 text-danger">
              *
            </span>
          )}
        </label>
      )}
      {labelled}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : helper ? (
        <p id={`${id}-helper`} className="text-caption text-muted">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: ReactNode;
  helper?: ReactNode;
  label?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helper, error, className, id, ...rest },
  ref,
) {
  return (
    <Field label={label} helper={helper} error={error} htmlFor={id} required={rest.required}>
      <input
        ref={ref}
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? undefined : helper ? undefined : undefined}
        className={cn(fieldClasses(!!error), "h-9", className)}
        {...rest}
      />
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, helper, error, className, id, ...rest },
  ref,
) {
  return (
    <Field label={label} helper={helper} error={error} htmlFor={id} required={rest.required}>
      <textarea
        ref={ref}
        id={id}
        aria-invalid={!!error}
        className={cn(fieldClasses(!!error), "min-h-20 py-2", className)}
        {...rest}
      />
    </Field>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, helper, error, options, placeholder, className, id, children, ...rest },
  ref,
) {
  return (
    <Field label={label} helper={helper} error={error} htmlFor={id} required={rest.required}>
      <select
        ref={ref}
        id={id}
        aria-invalid={!!error}
        className={cn(fieldClasses(!!error), "h-9 appearance-none bg-no-repeat pr-8", className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
          backgroundPosition: "right 8px center",
        }}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </Field>
  );
});

export function Checkbox({
  label,
  checked,
  onChange,
  description,
  className,
  ...rest
}: { label: ReactNode; description?: ReactNode; checked?: boolean; onChange?: (v: boolean) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type"
>) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-sm text-foreground", className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded accent-[#5AA8AA]"
        {...rest}
      />
      <span>
        {label}
        {description && <span className="block text-caption text-muted">{description}</span>}
      </span>
    </label>
  );
}

"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

/** A one-line print trigger; the report itself is plain server-rendered HTML. */
export function PrintButton({ label = "Print / save PDF" }: { label?: string }) {
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      <Printer className="mr-1.5 h-4 w-4" />
      {label}
    </Button>
  );
}

"use client";

/**
 * Row-Level Security management panel (Settings → Security).
 *
 * Power BI–style RLS rules: bind a workspace role to a dataset column and the
 * values that role may see. Rules are enforced server-side on every visual/
 * measure/query path (see lib/server/rls.ts) — this panel only edits the
 * declarative rule set. Saving replaces the whole rule set (OWNER-only).
 */

import { Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ErrorMessage } from "@/components/ui/feedback";
import { Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Card } from "@/components/ui/primitives";
import { api, errorMessage } from "@/lib/client/api";

interface RlsRuleView {
  role: string;
  datasetId: string;
  column: string;
  values: string; // comma-separated in the editor
}

interface RlsDataset {
  id: string;
  name: string;
  columns: string[];
}

const ROLES = ["VIEWER", "EDITOR", "OWNER"] as const;

export function RlsPanel() {
  const { toast } = useToast();
  const [rules, setRules] = useState<RlsRuleView[]>([]);
  const [datasets, setDatasets] = useState<RlsDataset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{
          rules: { role: string; datasetId: string; column: string; values: (string | number | boolean)[] }[];
          datasets: RlsDataset[];
        }>("/api/rls/rules");
        if (cancelled) return;
        setDatasets(res.datasets);
        setRules(
          res.rules.map((r) => ({
            role: r.role,
            datasetId: r.datasetId,
            column: r.column,
            values: r.values.map(String).join(", "),
          })),
        );
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addRule = () => {
    const first = datasets[0];
    setRules((rs) => [
      ...rs,
      {
        role: "VIEWER",
        datasetId: first?.id ?? "",
        column: first?.columns[0] ?? "",
        values: "",
      },
    ]);
  };

  const patch = (i: number, p: Partial<RlsRuleView>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = rules.map((r) => ({
        role: r.role,
        datasetId: r.datasetId,
        column: r.column.trim(),
        values: r.values
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v !== "")
          .map((v) => (v !== "" && Number.isFinite(Number(v)) ? Number(v) : v)),
      }));
      await api("/api/rls/rules", { method: "PUT", body: JSON.stringify({ rules: payload }) });
      toast({
        title: "RLS rules saved",
        message: "Restricted roles now see only the rows their rules allow — enforced server-side on every query.",
        type: "success",
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const datasetById = new Map(datasets.map((d) => [d.id, d]));

  return (
    <section aria-label="Row-level security">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-h3 text-foreground">
            <ShieldCheck aria-hidden className="size-5 text-accent" /> Row-level security (RLS)
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Restrict what each role can see in every visual, pivot and SQL query. A rule binds a role to a dataset
            column and the values that role may see; filters combine (AND) when several rules apply. Enforcement is
            server-side — restricted users cannot bypass it from the UI, and a restricted view is always labelled.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={addRule} icon={<Plus aria-hidden className="size-4" />}>
            Add rule
          </Button>
          <Button size="sm" onClick={save} loading={busy} icon={<Save aria-hidden className="size-4" />}>
            Save rules
          </Button>
        </div>
      </div>

      {error && <ErrorMessage title="Could not save RLS rules" message={error} className="mt-3" />}

      {loaded && rules.length === 0 && (
        <Card className="mt-4 p-4 text-sm text-muted">
          No RLS rules — every role sees all rows of every dataset they can access. Add a rule to scope a role (for
          example VIEWER → Region ∈ East) to a subset of rows.
        </Card>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {rules.map((r, i) => {
          const ds = datasetById.get(r.datasetId);
          return (
            <Card key={i} className="grid grid-cols-1 items-end gap-2 p-3 md:grid-cols-[140px_1fr_1fr_1fr_auto]">
              <Field label="Role">
                <Select value={r.role} onChange={(e) => patch(i, { role: e.target.value })}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Dataset">
                <Select
                  value={r.datasetId}
                  onChange={(e) => {
                    const next = datasetById.get(e.target.value);
                    patch(i, { datasetId: e.target.value, column: next?.columns[0] ?? "" });
                  }}
                >
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Column">
                <Select value={r.column} onChange={(e) => patch(i, { column: e.target.value })}>
                  {(ds?.columns ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {!ds?.columns?.includes(r.column) && r.column && (
                    <option value={r.column}>{r.column} (missing)</option>
                  )}
                </Select>
              </Field>
              <Field label="Allowed values (comma-separated)">
                <Input
                  value={r.values}
                  onChange={(e) => patch(i, { values: e.target.value })}
                  placeholder="East, West"
                />
              </Field>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove rule"
                onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                icon={<Trash2 aria-hidden className="size-4" />}
              />
            </Card>
          );
        })}
      </div>
    </section>
  );
}

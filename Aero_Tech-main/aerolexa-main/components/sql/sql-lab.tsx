"use client";

import { Braces, Database, Play, Save } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DemoBadge, ErrorMessage } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { api, ApiClientError, errorMessage } from "@/lib/client/api";
import { isBrowserDuckDbSupported, runBrowserSqlMany } from "@/lib/engine/duckdb/browser";
import { SqlError, SQL_SUPPORT_NOTE, sqlFromTable } from "@/lib/engine/sql";
import type { ColType, SqlResultSet, SqlValue } from "@/lib/types";

export interface SqlColumnMeta {
  name: string;
  type: string;
}

interface RunResponse {
  result: SqlResultSet;
  dataset: { id: string; name: string; totalRows: number };
}

/** Payload of GET /api/datasets/[id]/rows — typed rows for in-browser execution. */
interface RowsResponse {
  columns: { name: string; type: ColType }[];
  rows: SqlValue[][];
  totalRows: number;
  loadedRows: number;
  rowCap: number;
}

export interface SqlDatasetOption {
  id: string;
  name: string;
  columns: { name: string; type: ColType }[];
}

export function SqlLab({
  datasetId,
  datasetName,
  columns,
  totalRows,
  datasets = [{ id: datasetId, name: datasetName, columns: columns as { name: string; type: ColType }[] }],
}: {
  datasetId: string;
  datasetName: string;
  columns: SqlColumnMeta[];
  totalRows: number;
  datasets?: SqlDatasetOption[];
}) {
  const { toast } = useToast();
  const [sql, setSql] = useState(`SELECT * FROM ${tableAlias(datasetName)} LIMIT 100`);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Explicit engine-level failure (DuckDB could not start). Kept separate from
  // query errors so the UI can offer a real remedy instead of "check your SQL".
  const [engineIssue, setEngineIssue] = useState<string | null>(null);
  const [materializeName, setMaterializeName] = useState("");
  const [materializing, setMaterializing] = useState(false);
  const [materializedId, setMaterializedId] = useState<string | null>(null);
  // Initialised to the server engine: the badge reflects reality (the server
  // path is the guarantee) until the first in-browser run succeeds, and the
  // initialiser must NOT call isBrowserDuckDbSupported() — it differs between
  // server and client renders and would break hydration.
  const [engine, setEngine] = useState<"duckdb-browser" | "duckdb-server" | "prototype">("duckdb-server");
  const [sourceIds, setSourceIds] = useState<string[]>([datasetId]);
  const rowsRef = useRef<Map<string, RowsResponse>>(new Map());

  const browserSupported = isBrowserDuckDbSupported();

  /**
   * Try the in-browser DuckDB engine first. After the one-time row fetch every
   * query runs locally (no network), which keeps repeat runs well under
   * 100 ms. Falls back to the server API when the engine cannot initialize,
   * when the row fetch fails, or when the browser path is disabled.
   */
  const runBrowser = async (): Promise<RunResponse | null> => {
    if (!browserSupported) return null;
    try {
      const selected = datasets.filter((dataset) => sourceIds.includes(dataset.id));
      const loaded = await Promise.all(
        selected.map(async (dataset) => {
          const cached =
            rowsRef.current.get(dataset.id) ?? (await api<RowsResponse>(`/api/datasets/${dataset.id}/rows`));
          rowsRef.current.set(dataset.id, cached);
          return { dataset, data: cached };
        }),
      );
      const coverageNote = loaded
        .map(({ dataset, data }) =>
          data.loadedRows < data.totalRows
            ? `${dataset.name}: first ${data.loadedRows.toLocaleString()} of ${data.totalRows.toLocaleString()} rows scanned.`
            : "",
        )
        .filter(Boolean)
        .join(" ");
      // Backward compatibility with the server engine: a single dataset is also
      // registered under the table name the query references (e.g. `FROM sales`).
      const browserSources = loaded.map(({ dataset, data }) => ({
        name: tableAlias(dataset.name),
        columns: data.columns,
        rows: data.rows,
      }));
      if (browserSources.length === 1) {
        const referenced = sqlFromTable(sql);
        if (referenced && referenced !== browserSources[0]!.name) {
          browserSources.push({ ...browserSources[0]!, name: referenced });
        }
      }
      const result = await runBrowserSqlMany(browserSources, { sql, rowCap: loaded[0]?.data.rowCap, coverageNote });
      return {
        result: {
          ...result,
          note: `${result.note} In-browser execution — after the initial row load, the query ran on this device and nothing was sent to the server.`,
        },
        dataset: {
          id: datasetId,
          name: datasetName,
          totalRows: loaded.reduce((sum, item) => sum + item.data.totalRows, 0),
        },
      };
    } catch (err) {
      // A real SQL error (bad column, syntax) is the user's query failing, not
      // the engine — surface it instead of masking it with a server round trip.
      if (err instanceof SqlError) throw err;
      return null; // engine unavailable / row fetch failed → server API
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setEngineIssue(null);
    try {
      const browserRun = await runBrowser();
      if (browserRun) {
        setResult(browserRun);
        setEngine("duckdb-browser");
        return;
      }
      const data = await api<RunResponse>(`/api/datasets/${datasetId}/query`, {
        method: "POST",
        body: JSON.stringify({ sql, datasetIds: sourceIds }),
      });
      setResult(data);
      setEngine(data.result.engine === "duckdb" ? "duckdb-server" : "prototype");
    } catch (err) {
      setResult(null);
      if (err instanceof ApiClientError && err.code === "ENGINE_UNAVAILABLE") {
        // The real engine refused to start — say so plainly and never pretend a
        // weaker fallback ran (SQL_PROTOTYPE_FALLBACK can opt into that).
        setEngineIssue(err.message);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setRunning(false);
    }
  };

  const materialize = async () => {
    setMaterializing(true);
    setError(null);
    try {
      const data = await api<{ datasetId: string; name: string; rowCount: number; warnings: number }>(
        `/api/datasets/${datasetId}/materialize`,
        {
          method: "POST",
          body: JSON.stringify({ sql, name: materializeName.trim() || `${datasetName} · query result` }),
        },
      );
      toast({
        title: "Dataset materialized",
        message: `“${data.name}” with ${data.rowCount.toLocaleString()} rows${data.warnings ? ` (${data.warnings} quality warning(s))` : ""}.`,
        type: "success",
      });
      setMaterializedId(data.datasetId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMaterializing(false);
    }
  };

  const quick = (q: string) => () => setSql(q);

  const engineLabel =
    engine === "duckdb-browser"
      ? "DuckDB · in-browser"
      : engine === "duckdb-server"
        ? "DuckDB · server"
        : "prototype engine";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">
          Querying <span className="font-medium text-foreground">{datasetName}</span> · {totalRows.toLocaleString()}{" "}
          rows
        </span>
        <Badge variant="outline">
          <Database aria-hidden className="size-3" /> {engineLabel}
        </Badge>
        <div className="flex-1" />
        {engine === "prototype" ? (
          <DemoBadge tooltip={SQL_SUPPORT_NOTE} />
        ) : (
          <Badge variant="outline" title="Read-only SELECT on the DuckDB engine; DDL/DML is rejected.">
            read-only SELECT
          </Badge>
        )}
      </div>

      {datasets.length > 1 && (
        <Card className="mb-3 p-4">
          <p className="text-sm font-medium text-foreground">Datasets available for this project</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {datasets.map((source) => (
              <label key={source.id} className="flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={sourceIds.includes(source.id)}
                  onChange={(event) =>
                    setSourceIds((current) =>
                      event.target.checked
                        ? [...new Set([...current, source.id])]
                        : current.filter((id) => id !== source.id),
                    )
                  }
                />
                {source.name}
              </label>
            ))}
          </div>
          <p className="mt-2 text-caption text-muted">
            Use each selected dataset&apos;s table name in SQL, for example: customers JOIN orders.
          </p>
        </Card>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap gap-1.5 border-b border-line bg-surface px-3 py-2">
          <button
            onClick={quick(`SELECT * FROM ${tableAlias(datasetName)} LIMIT 100`)}
            className="rounded-md border border-line px-2 py-1 text-caption text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-line active:scale-95 hover:bg-surface-2 hover:text-foreground"
          >
            SELECT * LIMIT 100
          </button>
          <button
            onClick={quick(`SELECT COUNT(*) AS rows FROM ${tableAlias(datasetName)}`)}
            className="rounded-md border border-line px-2 py-1 text-caption text-muted hover:bg-surface-2 hover:text-foreground"
          >
            COUNT rows
          </button>
          {columns
            .filter((c) => c.type === "number")
            .slice(0, 3)
            .map((c) => (
              <button
                key={c.name}
                onClick={quick(
                  `SELECT ${c.name}, COUNT(*) AS n FROM ${tableAlias(datasetName)} GROUP BY ${c.name} ORDER BY n DESC LIMIT 10`,
                )}
                className="max-w-56 truncate rounded-md border border-line px-2 py-1 text-caption text-muted hover:bg-surface-2 hover:text-foreground"
                title={`SUM/AVG etc. work on ${c.name}`}
              >
                group by {c.name}
              </button>
            ))}
        </div>
        <label htmlFor="sql-input" className="sr-only">
          SQL query
        </label>
        <textarea
          id="sql-input"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          spellCheck={false}
          className="w-full resize-y bg-background px-3 py-2.5 font-mono text-[13px] leading-relaxed focus:outline-none"
          rows={7}
          aria-describedby="sql-help"
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-3 py-2">
          <Button onClick={() => void run()} loading={running} icon={<Play aria-hidden className="size-4" />}>
            Run query
          </Button>
          <Button
            variant="secondary"
            onClick={() => void materialize()}
            loading={materializing}
            disabled={!result || result.result.rows.length === 0}
            icon={<Save aria-hidden className="size-4" />}
          >
            Materialize as dataset
          </Button>
          {result && (
            <input
              aria-label="Name for the materialized dataset"
              value={materializeName}
              onChange={(e) => setMaterializeName(e.target.value)}
              placeholder={`${datasetName} · query result`}
              className="h-8 w-56 rounded-md border border-line bg-surface px-2 text-sm focus:outline-none focus:ring-2 focus:ring-focus/60"
            />
          )}
          {materializedId && (
            <Link href={`/datasets/${materializedId}`}>
              <Button variant="ghost" size="sm">
                Open new dataset →
              </Button>
            </Link>
          )}
          <span id="sql-help" className="ml-auto hidden text-caption text-muted md:inline">
            Ctrl/⌘ + Enter to run
          </span>
        </div>
      </div>

      {engineIssue && (
        <ErrorMessage
          title="Query engine unavailable"
          message={engineIssue}
          howToFix="This is an engine problem, not a problem with your query — nothing was run. Restore the DuckDB engine, or explicitly opt into degraded mode, then retry."
          onRetry={() => void run()}
          className="mt-4"
        />
      )}

      {error && (
        <ErrorMessage
          title="Query failed"
          message={error}
          howToFix="Check the query for typos — SELECT only, one statement, and column names must exist on this dataset."
          onRetry={result ? () => void run() : undefined}
          className="mt-4"
        />
      )}

      {result && (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-h3 text-foreground">
              {result.result.rowCount.toLocaleString()} row{result.result.rowCount === 1 ? "" : "s"}
            </h2>
            {result.result.truncated && <Badge variant="warning">truncated at limit</Badge>}
            <span className="text-caption text-muted">{result.result.executionMs} ms</span>
          </div>
          <DataTable
            columns={result.result.columns.map((c) => ({
              key: c.name,
              label: c.name,
              format: c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
            }))}
            rows={result.result.rows as (string | number | null)[][]}
            pageSize={10}
          />
          <p className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-caption text-muted">
            {result.result.note}
          </p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardContent>
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Braces aria-hidden className="size-4 text-accent" /> Supported
            </p>
            {engine === "prototype" ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                <li>SELECT columns and expressions</li>
                <li>WHERE with =, &lt;&gt;, &lt;, &lt;=, &gt;, &gt;=, AND / OR / NOT, IS [NOT] NULL</li>
                <li>GROUP BY with COUNT / SUM / AVG / MIN / MAX</li>
                <li>ORDER BY (ordinals, aliases, columns) and LIMIT</li>
              </ul>
            ) : (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                <li>Read-only SELECT with the full DuckDB grammar</li>
                <li>WHERE, GROUP BY, HAVING, ORDER BY, LIMIT</li>
                <li>JOINs, subqueries, CASE, window functions, string &amp; date functions</li>
                <li>DDL / DML / multiple statements are rejected</li>
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm font-medium text-foreground">Schema ({columns.length})</p>
            <ul className="mt-2 thin-scroll max-h-44 space-y-1 overflow-y-auto text-sm">
              {columns.map((c) => (
                <li key={c.name} className="flex items-center justify-between gap-2 text-muted">
                  <span className="truncate" title={c.name}>
                    {c.name}
                  </span>
                  <Badge variant="outline">{c.type}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="text-sm">
            <p className="font-medium text-foreground">How is this calculated?</p>
            {engine === "prototype" ? (
              <p className="mt-1 text-muted">
                The prototype SQL engine executes read-only SELECTs deterministically over the first loaded rows of this
                dataset — there is no live database and no DDL/DML is possible. Results are safe to use for exploration;
                treat them like any prototype output.
              </p>
            ) : engine === "duckdb-browser" ? (
              <p className="mt-1 text-muted">
                DuckDB-wasm runs the query in your browser over the exact rows of this dataset — an in-memory temp table
                inside the page&apos;s sandbox, so nothing beyond this dataset is reachable. Read-only SELECTs only;
                repeat queries stay on this device for fast iteration.
              </p>
            ) : (
              <p className="mt-1 text-muted">
                The DuckDB engine (in-memory, on the server) executes the read-only SELECT over the exact rows of this
                dataset. External file access is disabled; DDL/DML is impossible.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function tableAlias(name: string): string {
  const clean = name
    .replace(/[^a-zA-Z0-9_ ]/g, " ")
    .trim()
    .split(/\s+/)
    .join("_")
    .toLowerCase();
  return clean || "dataset";
}

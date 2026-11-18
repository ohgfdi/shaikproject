"use client";

import { useState, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/primitives";
import { api } from "@/lib/client/api";

function SQLLabPage() {
  const [query, setQuery] = useState(
    "SELECT * FROM engagement WHERE id = 'eng_123'"
  );
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<
    { query: string; success: boolean }[]
  >([]);

  const executeQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const apiRes = await api<{ rows: Record<string, unknown>[] }>(
        "/api/sql-lab/execute",
        {
          method: "POST",
          body: JSON.stringify({ query }),
        }
      );
      setResults(apiRes.rows ?? []);
      setHistory((prev) => [
        { query, success: true },
        ...prev.slice(0, 9),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query execution failed");
    } finally {
      setLoading(false);
    }
  }, [query]);

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold">SQL Lab</h3>
        <p className="text-sm text-muted">
          Execute queries against engagement database (SQL_LAB_ENABLED=true)
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="block text-sm font-medium mb-2">Query</label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="SELECT * FROM engagement WHERE id = 'eng_123'"
              rows={4}
              className="w-full rounded-md border p-2 font-mono text-sm"
            />
          </div>
          <div>
            <Button
              onClick={executeQuery}
              disabled={loading}
              variant={loading ? "secondary" : "primary"}
            >
              {loading ? "Running…" : "Execute"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="mt-3 p-3 rounded bg-red-100 text-red-800 text-sm">
            {error}
          </div>
        )}

        {loading && (
          <p className="mt-2 text-sm text-muted">Executing…</p>
        )}

        {results.length > 0 && (
          <div className="mt-4 max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead>
                <tr>
                  {Object.keys(results[0] || {}).map((key) => (
                    <th key={key} className="p-2 border bg-secondary">
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((row, i) => (
                  <tr key={i}>
                    {Object.values(row || {}).map((cell, j) => (
                      <td key={j} className="p-2 border">
                        {String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {history.length > 0 && (
          <div className="mt-4">
            <p className="text-caption text-muted uppercase">Recent Queries</p>
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {history.map((h, i) => (
                <li
                  key={i}
                  className="px-2 py-1 rounded-md hover:bg-secondary/20"
                >
                  <span className="flex-1 truncate">
                    {h.query.substring(0, 60)}…
                  </span>
                  <span className="text-caption">
                    {h.success ? "✓" : "✗"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
// Next.js page modules must expose a default export.
export default SQLLabPage;

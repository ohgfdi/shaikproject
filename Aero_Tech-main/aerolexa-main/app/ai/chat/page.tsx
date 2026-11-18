"use client";

import { useState, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Card, CardHeader, CardContent } from "@/components/ui/primitives";

function AITaxChatPage() {
  const [mode, setMode] = useState<"prepare-itr" | "tax-query" | "tax-planning">(
    "prepare-itr" as const
  );
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<any | null>(null);
  const [form, setForm] = useState({
    clientName: "",
    financialYear: new Date().getFullYear().toString(),
    totalIncome: "",
    entityKind: "individual",
  });
  const { toast } = useToast();

  const executeAI = useCallback(async () => {
    setLoading(true);
    setResponse(null);
    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      setResponse(data);
      if (data.error) {
        toast({ title: "Error", message: data.error, type: "error" });
      } else {
        toast({ title: "Success", message: `AI generated ${data.type}`, type: "success" });
      }
    } catch (err: any) {
      setResponse({ error: err.message });
      toast({ title: "Error", message: err.message, type: "error" });
    } finally {
      setLoading(false);
    }
  }, [form]);

  const handleModeChange = (newMode: "prepare-itr" | "tax-query" | "tax-planning") => {
    setMode(newMode);
    setForm({
      clientName: "",
      financialYear: new Date().getFullYear().toString(),
      totalIncome: "",
      entityKind: "individual",
    });
  };

  return (
    <Card>
      <CardHeader>
        <h3 className="font-semibold">AI Tax Assistant</h3>
        <p className="text-sm text-muted">
          Natural-language tax preparation & planning
        </p>
      </CardHeader>
      <CardContent>
        <Button
          onClick={() => setMode("prepare-itr")}
          className="mb-2"
        >
          Prepare ITR
        </Button>
        <Button
          onClick={() => setMode("tax-query")}
          className="mb-2"
        >
          Tax Query
        </Button>
        <Button
          onClick={() => setMode("tax-planning")}
          className="mb-2"
        >
          Tax Planning
        </Button>

        {mode === "prepare-itr" && (
          <Select
            value={form.entityKind}
            onChange={(e) =>
              setForm((f) => ({ ...f, entityKind: (e.target as any).value }))
            }
          >
            <option value="individual">Individual</option>
            <option value="HUF">HUF</option>
            <option value="company">Company</option>
            <option value="firm">Firm</option>
            <option value="LLP">LLP</option>
          </Select>
        )}

        {mode === "tax-query" && (
          <div className="mt-3 space-y-2">
            <Input
              placeholder="Client Name"
              value={form.clientName}
              onChange={(e) =>
                setForm((f) => ({ ...f, clientName: e.target.value }))
              }
            />
            <Input
              placeholder="Financial Year"
              type="number"
              value={form.financialYear}
              onChange={(e) =>
                setForm((f) => ({ ...f, financialYear: e.target.value }))
              }
            />
            <Input
              placeholder="Total Income (₹)"
              type="number"
              value={form.totalIncome}
              onChange={(e) =>
                setForm((f) => ({ ...f, totalIncome: e.target.value }))
              }
            />
            <Button
              onClick={() =>
                setForm((f) => ({ ...f, clientName: "", financialYear: new Date().getFullYear().toString(), totalIncome: "" }))
              }
              className="btn-sm text-muted"
            >
              Clear
            </Button>
          </div>
        )}

        {mode === "tax-planning" && (
          <div className="mt-3 space-y-2">
            <Input
              placeholder="Client Name"
              value={form.clientName}
              onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
            />
            <Input
              placeholder="Financial Year"
              type="number"
              value={form.financialYear}
              onChange={(e) =>
                setForm((f) => ({ ...f, financialYear: e.target.value }))
              }
            />
            <Button
              onClick={() => setMode("prepare-itr")}
              className="btn-sm text-primary"
            >
              Generate ITR
            </Button>
            {form.clientName && form.financialYear && (
              <Button
                onClick={() => setForm((f) => ({ ...f, tips: [] }))}
                className="btn-sm text-muted"
              >
                Clear
              </Button>
            )}
          </div>
        )}

        <Input
          placeholder="Client Name"
          value={form.clientName}
          onChange={(e) =>
            setForm((f) => ({ ...f, clientName: e.target.value }))
          }
        />
        <Input
          placeholder="Financial Year"
          type="number"
          value={form.financialYear}
          onChange={(e) =>
            setForm((f) => ({ ...f, financialYear: e.target.value }))
          }
        />
        <Input
          placeholder="Total Income (₹)"
          type="number"
          value={form.totalIncome}
          onChange={(e) =>
            setForm((f) => ({ ...f, totalIncome: e.target.value }))
          }
        />

        <Button
          onClick={executeAI}
          disabled={loading}
          className="mt-2 w-full"
        >
          {loading ? "Generating…" : "Generate"}
        </Button>

        {response && (
          <p>
            {response.error || response.type === "tax-query" ? (
              <strong>{response.question || "No question"}</strong>
            ) : ""}
            {response && response.type === "tax-planning" && (
              <>
                <strong>Planning Tips:</strong>
                <ul className="mt-2 list-disc list-inside">
                  {response.planningTips.map((tip: string, i: number) => (
                    <li key={i}>{tip}</li>
                  ))}
                </ul>
              </>
            )}
            {response && response.type === "itr-preparation" && (
              <>
                <strong>ITR Form:</strong> {response.result?.itrForm}
                <br />
                <strong>Reason:</strong> {response.result?.formReason}
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
// Next.js page modules must expose a default export.
export default AITaxChatPage;

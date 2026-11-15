import { ApiError, requireAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { loadParsedDataset } from "@/lib/engine/dataset";
import { buildLlmPrompt, isSafeDslCommand, translateToDsl } from "@/lib/engine/nl-to-code";
import { executeNotebookCell } from "@/lib/engine/notebook-dsl";
import { assertSafePythonCode } from "@/lib/engine/python/code-gate";
import { buildPandasLlmPrompt, translateToPandas } from "@/lib/engine/python/nl-to-pandas";
import { runServerPython, serverPythonEnabled } from "@/lib/engine/python/python-kernel";
import { serverEnv } from "@/lib/env";
import { getLiveLLMProvider } from "@/lib/llm/providers";
import { datasetColumns } from "@/lib/serialize";
import { logActivity } from "@/lib/server/activity";
import { ok, readJsonBody, toErrorResponse } from "@/lib/server/api";
import { applyRowSecurity } from "@/lib/server/dataset-access";
import { requireRowRole } from "@/lib/server/members";
import { requireModule } from "@/lib/server/modules";
import { RATE_LIMITS, enforceUserRateLimit } from "@/lib/server/rate-limit";
import type { NotebookCellOutput } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Notebook copilot — three real paths, honestly labelled, no fabrication:
 *
 *   1. "llm"               — when a live model is configured, it writes a pandas
 *                            cell for the request. That code passes the Python
 *                            safety gate and executes on the real server kernel
 *                            (Pyodide wasm worker). A rejected/failed answer
 *                            falls through to path 2, never to a guess.
 *   2. "deterministic-pandas" — no model configured: a deterministic NL→pandas
 *                            translator (keyword + schema matching) writes the
 *                            same kind of cell. Also gated, also really executed.
 *   3. "deterministic"     — the original DSL path: known, whitelisted %commands
 *                            only, executed through the DSL engine.
 *
 * Every response states which path produced the code and which kernel ran it.
 * The copilot never returns numbers it did not compute: when a request cannot
 * be mapped to runnable code, the answer is "I couldn't map that" + guidance.
 */

/** Ask the live model for a pandas cell. Returns null when unavailable/failed. */
async function askLiveModel(systemPrompt: string): Promise<{ content: string; source: "ollama" | "llm" } | null> {
  const provider = getLiveLLMProvider();
  if (!provider) return null;
  try {
    if (!(await provider.isAvailable())) return null;
    const response = await provider.generate({
      systemPrompt,
      userPrompt: "Return exactly one pandas code cell and nothing else.",
      maxTokens: 300,
      temperature: 0,
      timeout: 20000,
    });
    if (!response.content?.trim()) return null;
    return { content: stripFences(response.content), source: provider.name === "ollama" ? "ollama" : "llm" };
  } catch {
    return null;
  }
}

/** Models love markdown fences; the kernel does not. */
function stripFences(code: string): string {
  const fenced = /```(?:python|py)?\s*([\s\S]*?)```/.exec(code);
  return (fenced ? fenced[1]! : code).trim();
}

/** Shared context loading for all three paths. */
async function loadContext(ctx: Awaited<ReturnType<typeof requireAuth>>, notebookId: string) {
  const notebook = await prisma.notebook.findUnique({
    where: { id: notebookId },
    include: { dataset: { select: { id: true, name: true } } },
  });
  await requireRowRole(ctx, notebook, "VIEWER");
  if (!notebook) throw new ApiError(404, "NOT_FOUND", "Notebook not found.");

  const datasetId = notebook.datasetId ?? notebook.dataset?.id;
  if (!datasetId) {
    throw new ApiError(400, "VALIDATION", "Attach a dataset to this notebook before asking the assistant.");
  }
  const dataset = await prisma.dataset.findUnique({ where: { id: datasetId } });
  if (!dataset) throw new ApiError(404, "NOT_FOUND", "Dataset not found.");
  await requireRowRole(ctx, dataset, "VIEWER");

  const columns = datasetColumns(dataset);
  const loaded = await loadParsedDataset(dataset.id, serverEnv().DATASET_ANALYSIS_LIMIT);
  // RLS: the assistant's context must match what the user can see elsewhere.
  const rls = await applyRowSecurity(ctx, dataset, { rows: loaded.rows, columns });
  const dsCtx = {
    datasetName: dataset.name,
    columns,
    rows: rls.rows,
    totalRows: loaded.totalRows,
    rowLimit: 25,
  };
  return { notebook, dataset, columns, dsCtx };
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    requireModule("NOTEBOOK_ENABLED");
    const ctx = await requireAuth();
    enforceUserRateLimit(ctx.user.id, "copilot", RATE_LIMITS.copilot);

    const body = await readJsonBody<{ request?: string }>(request);
    const userRequest = (body.request ?? "").trim().slice(0, 500);
    if (!userRequest) {
      throw new ApiError(400, "VALIDATION", "Describe what you want to compute, e.g. “average revenue”.");
    }

    const { notebook, dataset, columns, dsCtx } = await loadContext(ctx, params.id);

    // ------------------------------------------------------------------
    // Path 1: live model → pandas cell (gated, executed on the real kernel)
    // ------------------------------------------------------------------
    if (serverPythonEnabled()) {
      const live = await askLiveModel(buildPandasLlmPrompt(userRequest, columns, dataset.name));
      if (live) {
        const verdict = assertSafePythonCode(live.content);
        if (verdict.ok) {
          const output = await runServerPython(live.content, dsCtx);
          if (output.type !== "error") {
            await logActivity(
              ctx,
              "NOTEBOOK_CELL_RUN",
              `Notebook copilot (llm) answered for “${notebook.title}”`,
              notebook.projectId,
              {
                notebookId: notebook.id,
                datasetId: dataset.id,
                request: userRequest.slice(0, 200),
                source: "llm",
              },
            );
            return ok({
              code: live.content,
              explanation: `“${userRequest}” — pandas cell written by the configured model (${live.source}), passed the safety gate, and executed on the server Python kernel.`,
              output,
              source: "llm",
              kernel: "pyodide-server",
            });
          }
          // Model code ran but errored → surface honestly; try path 2 below.
          const pandas = translateToPandas(userRequest, columns);
          if (pandas.matched && assertSafePythonCode(pandas.code).ok) {
            const fallbackOutput = await runServerPython(pandas.code, dsCtx);
            return ok({
              code: pandas.code,
              explanation: `The model's cell failed on this data (${firstLine(output.message)}), so the deterministic pandas translator answered instead. ${pandas.explanation}`,
              output: fallbackOutput,
              source: "deterministic-pandas",
              kernel: "pyodide-server",
            });
          }
        }
        // Gated or errored → fall through to the deterministic paths.
      }
    }

    // ------------------------------------------------------------------
    // Path 2: deterministic pandas translator (needs the server kernel too)
    // ------------------------------------------------------------------
    if (serverPythonEnabled()) {
      const pandas = translateToPandas(userRequest, columns);
      if (pandas.matched && assertSafePythonCode(pandas.code).ok) {
        const output = await runServerPython(pandas.code, dsCtx);
        await logActivity(
          ctx,
          "NOTEBOOK_CELL_RUN",
          `Notebook copilot (deterministic-pandas) answered for “${notebook.title}”`,
          notebook.projectId,
          {
            notebookId: notebook.id,
            datasetId: dataset.id,
            request: userRequest.slice(0, 200),
            source: "deterministic-pandas",
          },
        );
        return ok({
          code: pandas.code,
          explanation: `“${userRequest}” — translated to pandas by the built-in deterministic translator and executed on the server Python kernel. ${pandas.explanation}`,
          output,
          source: "deterministic-pandas",
          kernel: "pyodide-server",
        });
      }
    }

    // ------------------------------------------------------------------
    // Path 3: DSL (original behaviour — works without the Python kernel)
    // ------------------------------------------------------------------
    let code = "";
    let source: "llm" | "ollama" | "deterministic" = "deterministic";
    const live = await askLiveModel(buildLlmPrompt(userRequest, columns, dataset.name));
    if (live && isSafeDslCommand(live.content)) {
      code = live.content;
      source = live.source;
    }
    let explanation = "";
    if (!code) {
      const translation = translateToDsl(userRequest, columns);
      if (!translation.matched) {
        throw new ApiError(
          422,
          "UNRECOGNIZED_REQUEST",
          translation.help ?? "I could not map that request to a command.",
        );
      }
      code = translation.code;
      explanation = translation.explanation;
    }

    const output: NotebookCellOutput = {
      ...executeNotebookCell(code, dsCtx),
      kernel: "dsl",
    };
    if (!explanation) {
      explanation =
        output.type === "error"
          ? `The command ran but produced an error: ${output.message}`
          : `“${userRequest}” — translated to a runnable DSL command and executed against “${dataset.name}”.`;
    }

    await logActivity(
      ctx,
      "NOTEBOOK_CELL_RUN",
      `Notebook copilot (${source}) answered for “${notebook.title}”`,
      notebook.projectId,
      {
        notebookId: notebook.id,
        datasetId: dataset.id,
        request: userRequest.slice(0, 200),
        source,
      },
    );

    return ok({ code, explanation, output, source, kernel: "dsl" });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.slice(0, 160) ?? "";
}

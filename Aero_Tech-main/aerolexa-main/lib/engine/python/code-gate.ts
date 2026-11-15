/**
 * Python code safety gate for AI-generated cells.
 *
 * The copilot's Python path may execute code written by a language model.
 * Before any generated source reaches the kernel it must pass this gate:
 *
 * - Import allow-list: data-science libraries only (pandas, numpy, scipy,
 *   sklearn, statsmodels, matplotlib and the stdlib bits the DSL relies on).
 * - Block-list: filesystem access, subprocess/os.system, sockets, eval/exec,
 *   and the dunder escape hatches (`__import__`, `__builtins__` probing).
 * - Kernel-level guarantees (documented, not enforced here): Pyodide wasm has
 *   no host filesystem and no sockets, so even a bypass cannot reach the
 *   server's disk or network. The gate keeps model output auditable and
 *   predictable; the sandbox is the real boundary.
 *
 * The gate is deliberately strict and explainable: every rejection names the
 * offending line so a user can fix the cell by hand.
 */

const ALLOWED_IMPORTS = new Set([
  // data stack
  "pandas",
  "numpy",
  "scipy",
  "sklearn",
  "statsmodels",
  "matplotlib",
  "seaborn",
  "plotly",
  // stdlib used by generated cells
  "json",
  "math",
  "statistics",
  "datetime",
  "re",
  "itertools",
  "collections",
  "decimal",
  "random",
  "textwrap",
  "string",
]);

const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b__import__\s*\(/, reason: "uses __import__ (dynamic import bypass)" },
  {
    pattern: /\bimport\s+(os|sys|subprocess|socket|shutil|ctypes|importlib|pathlib|tempfile|builtins)\b/,
    reason: "imports a blocked module",
  },
  {
    pattern: /\bfrom\s+(os|sys|subprocess|socket|shutil|ctypes|importlib|pathlib|tempfile|builtins)\b/,
    reason: "imports a blocked module",
  },
  {
    pattern: /\bos\.(system|popen|remove|unlink|rename|makedirs|rmdir|listdir|walk|environ)\b/,
    reason: "touches the filesystem or process environment",
  },
  { pattern: /\bopen\s*\(/, reason: "opens a file (cells have no filesystem)" },
  { pattern: /\bsubprocess|Popen|check_output\b/, reason: "runs a subprocess" },
  { pattern: /\bsocket\b|\brequests\b|\burllib\b|\bhttpx\b|\baiohttp\b/, reason: "opens a network connection" },
  { pattern: /\beval\s*\(|\bexec\s*\(/, reason: "uses eval/exec (dynamic code execution)" },
  {
    pattern: /\bglobals\s*\(\s*\)\s*\[|\bglobals\s*\(\s*\)\.update|__builtins__/,
    reason: "probes interpreter internals",
  },
  { pattern: /\bgetattr\s*\(\s*.*\s*,\s*['"]__/, reason: "reads a dunder attribute dynamically" },
];

export interface GateVerdict {
  ok: boolean;
  /** The reason the code was rejected (with the offending line, 1-indexed). */
  reason?: string;
}

/**
 * Validate AI-generated or user-typed Python before it reaches the kernel.
 * The deterministic NL→pandas translator also passes its output through here
 * so the guarantee is uniform: nothing executes that the gate would reject.
 */
export function assertSafePythonCode(code: string): GateVerdict {
  if (!code || !code.trim()) return { ok: false, reason: "The cell is empty." };

  // Dunder patterns run on the raw line (comments still stripped): unlike
  // os.system-style checks, the payload here IS a string argument
  // (getattr(df, "__globals__")), so string contents must not be masked.
  const RAW_DANGER: { pattern: RegExp; reason: string }[] = [
    {
      pattern: /__import__|__builtins__|__globals__|__subclasses__|__reduce__|__class__\s*\(/,
      reason: "touches interpreter internals",
    },
  ];

  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const noString = stripStringsAndComments(line);
    const noComment = stripComments(line);

    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(noString)) {
        return { ok: false, reason: `Line ${i + 1} ${reason}: ${line.trim().slice(0, 120)}` };
      }
    }
    for (const { pattern, reason } of RAW_DANGER) {
      if (pattern.test(noComment)) {
        return { ok: false, reason: `Line ${i + 1} ${reason}: ${line.trim().slice(0, 120)}` };
      }
    }

    const importMatch = /^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(noString);
    if (importMatch) {
      const root = importMatch[1]!.split(".")[0]!;
      if (!ALLOWED_IMPORTS.has(root)) {
        return {
          ok: false,
          reason: `Line ${i + 1} imports “${root}”, which is not on the allow-list. Allowed: pandas, numpy, scipy, sklearn, statsmodels, matplotlib, seaborn, plotly, and basic stdlib (json, math, statistics, datetime, re, itertools, collections, decimal, random).`,
        };
      }
    }
  }
  return { ok: true };
}

/** Remove comments only (everything after an unquoted #), keeping strings intact. */
function stripComments(line: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "#" && !inSingle && !inDouble) break;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    out += ch;
  }
  return out;
}

/** Remove string literal contents and comments so pattern checks don't match text inside strings. */
function stripStringsAndComments(line: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "#" && !inSingle && !inDouble) break; // comment — stop scanning
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (!inSingle && !inDouble) out += ch;
    // String contents are replaced by the quote chars themselves.
  }
  return out;
}

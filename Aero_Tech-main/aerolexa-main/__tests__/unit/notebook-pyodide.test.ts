import type { DslContext } from "@/lib/engine/notebook-dsl";
import { createPyodideKernel, type PyodideRuntime } from "@/lib/engine/notebook-pyodide";

const ctx: DslContext = {
  datasetName: "sales.csv",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["East", 1200],
    ["West", 1350],
  ],
  totalRows: 2,
  rowLimit: 5000,
};

function runtime(): PyodideRuntime & { calls: string[] } {
  const calls: string[] = [];
  const globals = new Map<string, unknown>();
  return {
    calls,
    globals: {
      set(name: string, value: unknown) {
        globals.set(name, value);
      },
      get(name: string) {
        return globals.get(name);
      },
    },
    async loadPackage(packages: string[]) {
      calls.push(`packages:${packages.join(",")}`);
    },
    async runPythonAsync(code: string) {
      calls.push(code);
      if (code.includes("__aerolexa_result__")) return "5";
      return undefined;
    },
  };
}

describe("createPyodideKernel", () => {
  it("initializes numpy and pandas with the active dataset as df", async () => {
    const pyodide = runtime();
    const kernel = createPyodideKernel(ctx, async () => pyodide);

    await kernel.ready;
    expect(pyodide.calls).toContain("packages:numpy,pandas,matplotlib");
    expect(pyodide.calls.some((code) => code.includes("DataFrame"))).toBe(true);
  });

  it("exposes project datasets as additional DataFrames", async () => {
    const pyodide = runtime();
    const kernel = createPyodideKernel(ctx, async () => pyodide, [
      { name: "customers", columns: [{ name: "id" }], rows: [[1]] },
    ]);

    await kernel.ready;
    expect(pyodide.calls.some((code) => code.includes("df_customers = pd.DataFrame"))).toBe(true);
  });

  it("preserves variables between cells", async () => {
    const pyodide = runtime();
    const kernel = createPyodideKernel(ctx, async () => pyodide);

    await expect(kernel.run("x = 5")).resolves.toMatchObject({ kernel: "pyodide" });
    const output = await kernel.run("x");

    expect(output).toMatchObject({ type: "text", text: "5", kernel: "pyodide" });
  });

  it("returns matplotlib output as an image", async () => {
    const pyodide = runtime();
    pyodide.globals.get = jest.fn((name: string) =>
      name === "__aerolexa_image__" ? { toJs: () => "png-data" } : undefined,
    );
    const kernel = createPyodideKernel(ctx, async () => pyodide);

    const output = await kernel.run("import matplotlib.pyplot as plt\nplt.plot(df['revenue'])\nplt.show()\n");

    expect(output).toMatchObject({
      type: "image",
      kernel: "pyodide",
      image: { mimeType: "image/png", data: "png-data" },
    });
  });
});

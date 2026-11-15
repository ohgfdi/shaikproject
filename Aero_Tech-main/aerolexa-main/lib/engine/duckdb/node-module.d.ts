/**
 * The duckdb-wasm node entry is a CJS bundle without its own .d.ts next to
 * it — redeclare it as the same API surface as the package's main types so
 * `await import("@duckdb/duckdb-wasm/dist/duckdb-node.cjs")` stays typed.
 */
declare module "@duckdb/duckdb-wasm/dist/duckdb-node.cjs" {
  export * from "@duckdb/duckdb-wasm";
}

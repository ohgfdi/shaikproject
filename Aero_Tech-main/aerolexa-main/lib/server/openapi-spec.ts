/**
 * OpenAPI 3.0 specification for the Ledgerly public API.
 *
 * Single source of truth: served as JSON by GET /api/public/openapi.json and
 * rendered by the Swagger UI page at /api/docs. The contract test
 * (__tests__/unit/openapi-contract.test.ts) pins internal consistency:
 * every security scheme referenced by a path must be declared, every
 * $ref must resolve, and operationIds must be unique.
 */

/**
 * Cookie-based session auth. The cookie is `ledgerly.session`; servers that
 * have not yet been upgraded still present `aerolexa.session`, which
 * `readSession()` accepts as a fallback (see lib/auth/session.ts).
 */
const SESSION_AUTH = {
  type: "apiKey",
  in: "cookie",
  name: "ledgerly.session",
  description:
    "Browser session auth (JWT cookie set by /login). Used by the API-key management endpoints; not for programmatic clients — create an API key instead.",
} as const;

/** API-key auth (`Authorization: Bearer ak_live_…`). */
const API_KEY_AUTH = {
  type: "apiKey",
  in: "header",
  name: "Authorization",
  description: "API key authentication. Format: Bearer ak_live_xxxxxxxx_yyyyyyyyyyyyyyyy",
} as const;

const ERROR_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", example: false },
    error: {
      type: "object",
      properties: {
        code: { type: "string", example: "NOT_FOUND" },
        message: { type: "string", example: "Dataset not found" },
      },
    },
  },
} as const;

const DATASET_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", format: "cuid" },
    name: { type: "string" },
    originalName: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "integer" },
    rowCount: { type: "integer" },
    columnCount: { type: "integer" },
    status: { type: "string", enum: ["PROCESSING", "READY", "ERROR"] },
    columns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["string", "number", "date", "boolean"] },
        },
      },
    },
    preview: { type: "array", items: { type: "array" } },
    profile: { type: "object" },
    qualityWarnings: { type: "array", items: { type: "string" } },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    project: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
    },
  },
} as const;

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Ledgerly Public API",
    version: "1.0.0",
    description: "Public API for Ledgerly - programmatic access to datasets, reports, and analytics.",
    contact: {
      name: "Ledgerly Support",
      email: "support@aerolexa.example.com",
    },
    license: {
      name: "Proprietary",
    },
  },
  servers: [
    {
      url: "/api/public/v1",
      description: "Public API v1",
    },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: API_KEY_AUTH,
      SessionAuth: SESSION_AUTH,
    },
    schemas: {
      Error: ERROR_SCHEMA,
      Dataset: DATASET_SCHEMA,
      DatasetList: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          datasets: {
            type: "array",
            items: { $ref: "#/components/schemas/Dataset" },
          },
          nextCursor: { type: "string", nullable: true },
          limit: { type: "integer" },
        },
      },
      DatasetResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          dataset: { $ref: "#/components/schemas/Dataset" },
        },
      },
      ApiKey: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          keyPrefix: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          rateLimit: { type: "integer" },
          lastUsedAt: { type: "string", format: "date-time", nullable: true },
          expiresAt: { type: "string", format: "date-time", nullable: true },
          revokedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CreateApiKeyRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 100 },
          scopes: { type: "array", items: { type: "string" } },
          rateLimit: { type: "integer", minimum: 1, maximum: 1000, default: 60 },
          expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
        },
      },
      CreateApiKeyResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          id: { type: "string" },
          name: { type: "string" },
          key: { type: "string" },
          keyPrefix: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          rateLimit: { type: "integer" },
          expiresAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          warning: { type: "string" },
        },
      },
      Report: {
        type: "object",
        properties: {
          id: { type: "string", format: "cuid" },
          title: { type: "string" },
          version: { type: "integer" },
          accessMode: { type: "string" },
          publishedAt: { type: "string", format: "date-time", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          project: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
          createdBy: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
      ReportList: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          reports: {
            type: "array",
            items: { $ref: "#/components/schemas/Report" },
          },
          nextCursor: { type: "string", nullable: true },
          limit: { type: "integer" },
        },
      },
      DatasetRowsResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          datasetId: { type: "string" },
          name: { type: "string" },
          columns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string", enum: ["string", "number", "date", "boolean"] },
              },
            },
          },
          rows: { type: "array", items: { type: "array" } },
          totalRows: { type: "integer" },
          loadedRows: { type: "integer" },
          rlsNote: { type: "string", nullable: true },
          sampleNote: { type: "string", nullable: true },
          versionId: { type: "string", nullable: true },
        },
      },
      SqlRequest: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: { type: "string", description: "A read-only SELECT statement (DDL/DML rejected)." },
          limit: { type: "integer", minimum: 1, maximum: 10000, description: "Optional result row cap." },
        },
      },
      SqlResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          datasetId: { type: "string" },
          datasetName: { type: "string" },
          columns: { type: "array", items: { type: "object" } },
          rows: { type: "array", items: { type: "array" } },
          rowCount: { type: "integer" },
          totalResultRows: { type: "integer" },
          truncated: { type: "boolean" },
          engineNote: { type: "string" },
        },
      },
      DaxRequest: {
        type: "object",
        required: ["measure"],
        properties: {
          measure: { type: "string", example: "SUM([Amount])", maxLength: 5000 },
          filters: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                values: { type: "array", items: { type: "string" } },
              },
            },
          },
          byCategory: { type: "string", description: "Group the measure by this column (returns a series)." },
        },
      },
      DaxResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", example: true },
          datasetId: { type: "string" },
          value: { type: "number", nullable: true },
          series: { type: "array", items: { type: "object" }, nullable: true },
          note: { type: "string" },
          rlsNote: { type: "string", nullable: true },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    "/datasets/{id}/rows": {
      get: {
        tags: ["Datasets"],
        summary: "Stream dataset rows",
        description:
          "Typed rows for one dataset, RLS-filtered and capped at the analysis limit. Supports ?version= to read an immutable historical snapshot.",
        operationId: "listDatasetRows",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "version",
            in: "query",
            schema: { type: "string" },
            description: "DatasetVersion id for a historical snapshot",
          },
        ],
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DatasetRowsResponse" } } },
          },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden (scope or RLS)" },
          "404": { description: "Not found" },
        },
      },
    },
    "/datasets/{id}/sql": {
      post: {
        tags: ["Datasets"],
        summary: "Run read-only SQL",
        description:
          "Run a read-only SELECT against a dataset on the DuckDB engine (JOINs, window functions, subqueries). DDL/DML rejected; results capped with exact totals.",
        operationId: "executeSql",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/SqlRequest" } } },
        },
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SqlResponse" } } },
          },
          "400": {
            description: "Invalid SQL",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden (scope or RLS)" },
          "404": { description: "Not found" },
        },
      },
    },
    "/datasets/{id}/dax": {
      post: {
        tags: ["Datasets"],
        summary: "Evaluate a DAX measure",
        description:
          "Evaluate a DAX measure with real filter-context semantics against the dataset's actual rows (the same oracle-tested engine as the DAX studio).",
        operationId: "executeDax",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/DaxRequest" } } },
        },
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DaxResponse" } } },
          },
          "400": {
            description: "Invalid measure",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden (scope or RLS)" },
          "404": { description: "Not found" },
        },
      },
    },
    "/datasets": {
      get: {
        tags: ["Datasets"],
        summary: "List datasets",
        description: "List datasets accessible via API key. Supports pagination via cursor.",
        operationId: "listDatasets",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: "projectId", in: "query", schema: { type: "string" }, description: "Filter by project ID" },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Pagination cursor" },
        ],
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DatasetList" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden - missing scope",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limited",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/datasets/{id}": {
      get: {
        tags: ["Datasets"],
        summary: "Get dataset",
        description: "Get a single dataset by ID with full details.",
        operationId: "getDataset",
        security: [{ ApiKeyAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DatasetResponse" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden - missing scope",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limited",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/reports": {
      get: {
        tags: ["Reports"],
        summary: "List reports",
        description: "List reports accessible via API key. Supports pagination via cursor.",
        operationId: "listReports",
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          { name: "projectId", in: "query", schema: { type: "string" }, description: "Filter by project ID" },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Pagination cursor" },
        ],
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ReportList" } } },
          },
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "403": {
            description: "Forbidden - missing scope",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "429": {
            description: "Rate limited",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/auth/api-keys": {
      // Session-auth endpoints live at the workspace root (/api/auth/api-keys),
      // NOT under /api/public/v1 — override the server so Try-it-out resolves
      // against the real route.
      servers: [{ url: "/", description: "Workspace root (session-auth endpoints)" }],
      get: {
        tags: ["API Keys"],
        summary: "List API keys",
        description: "List all API keys for the authenticated user (session auth).",
        operationId: "listApiKeys",
        security: [{ SessionAuth: [] }],
        responses: {
          "200": {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { apiKeys: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } } },
                },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
      post: {
        tags: ["API Keys"],
        summary: "Create API key",
        description: "Create a new API key. Returns the full key only once.",
        operationId: "createApiKey",
        security: [{ SessionAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateApiKeyRequest" } } },
        },
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateApiKeyResponse" } } },
          },
          "400": {
            description: "Bad request",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/auth/api-keys/{keyId}": {
      servers: [{ url: "/", description: "Workspace root (session-auth endpoints)" }],
      delete: {
        tags: ["API Keys"],
        summary: "Revoke API key",
        description: "Revoke (soft delete) an API key.",
        operationId: "revokeApiKey",
        security: [{ SessionAuth: [] }],
        parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Success" },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
      post: {
        tags: ["API Keys"],
        summary: "Regenerate API key",
        description: "Regenerate an API key (revokes old, creates new with same settings).",
        operationId: "regenerateApiKey",
        security: [{ SessionAuth: [] }],
        parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateApiKeyResponse" } } },
          },
          "401": { description: "Unauthorized" },
          "403": { description: "Forbidden" },
          "404": { description: "Not found" },
        },
      },
    },
  },
  tags: [
    { name: "Datasets", description: "Dataset management, rows, SQL and DAX execution" },
    { name: "Reports", description: "Report management" },
    { name: "API Keys", description: "API key management (requires session auth)" },
  ],
} as const;

/**
 * Walks the spec and asserts internal consistency. Returns a list of
 * human-readable problems — empty when the spec is coherent.
 */
export function openApiSpecProblems(spec: unknown): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    if (typeof obj.$ref === "string") {
      const ref = obj.$ref;
      seen.add(ref);
      let cur: unknown = spec;
      for (const part of ref.replace(/^#\//, "").split("/")) {
        if (cur === null || typeof cur !== "object" || !(part in (cur as Record<string, unknown>))) {
          problems.push(`Unresolvable $ref "${ref}" at ${path}`);
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[part];
      }
    }
    for (const [key, value] of Object.entries(obj)) walk(value, `${path}.${key}`);
  };

  walk(spec, "$");

  const specObj = spec as {
    components?: { securitySchemes?: Record<string, unknown> };
    paths?: Record<string, Record<string, { security?: Record<string, unknown>[]; operationId?: string }>>;
  };
  const declaredSchemes = Object.keys(specObj.components?.securitySchemes ?? {});

  const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);

  for (const [routePath, methods] of Object.entries(specObj.paths ?? {})) {
    for (const [method, op] of Object.entries(methods)) {
      // Path Item Objects also carry non-operation keys (servers, parameters,
      // summary…) — only HTTP methods are operations.
      if (!HTTP_METHODS.has(method)) continue;
      if (typeof op !== "object" || op === null) continue;
      if (!op.operationId) problems.push(`${method.toUpperCase()} ${routePath}: missing operationId`);
      else if (seen.has(`operation:${op.operationId}`)) problems.push(`Duplicate operationId "${op.operationId}"`);
      if (op.operationId) seen.add(`operation:${op.operationId}`);
      for (const sec of op.security ?? []) {
        for (const scheme of Object.keys(sec)) {
          if (!declaredSchemes.includes(scheme)) {
            problems.push(`${method.toUpperCase()} ${routePath}: references undeclared security scheme "${scheme}"`);
          }
        }
      }
    }
  }

  return problems;
}

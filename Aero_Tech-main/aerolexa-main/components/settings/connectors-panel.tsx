"use client";

import { Database, Link2, Plug, RefreshCw, Search, Trash2, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage, LoadingSkeleton } from "@/components/ui/feedback";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/overlays";
import { Badge, Card, CardContent } from "@/components/ui/primitives";
import { DataTable } from "@/components/ui/table";
import { api, errorMessage } from "@/lib/client/api";
import { ZOHO_BOOKS_REGIONS, zohoRegionMeta } from "@/lib/engine/connectors/zoho-regions";
import type {
  ConnectorChangeLog,
  ConnectorSample,
  ConnectorStatus,
  ConnectorSyncRunView,
  ConnectorTableInfo,
  ConnectorView,
} from "@/lib/types";

const SAMPLE_LIMITS = [
  { value: "10", label: "10 rows" },
  { value: "100", label: "100 rows" },
  { value: "1000", label: "1 000 rows" },
  { value: "5000", label: "5 000 rows" },
];

const SYNC_PRESETS = [
  { label: "Daily at 09:00", cron: "0 9 * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Weekly (Mon 09:00)", cron: "0 9 * * 1" },
];

interface TableSelection {
  schema: string;
  name: string;
}

export function ConnectorsPanel({ connectors: envStatuses }: { connectors: ConnectorStatus[] }) {
  const { toast } = useToast();
  const [items, setItems] = useState<ConnectorView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showRestImport, setShowRestImport] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ connectors: ConnectorView[] }>("/api/connectors");
      setItems(data.connectors);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-label="Data sources">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-h2 text-foreground">Data sources</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Connect external sources to import live schemas as datasets. Credentials are encrypted on the server
            (AES-256-GCM) and never reach the browser. Imports flow through the same profiling, SQL Lab, notebook and
            analysis pipeline as uploaded files.
          </p>
        </div>
        {!showForm && !showRestImport && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setShowRestImport(true)}
              variant="secondary"
              icon={<Link2 aria-hidden className="size-4" />}
            >
              Import from REST API
            </Button>
            <Button onClick={() => setShowForm(true)} icon={<Plug aria-hidden className="size-4" />}>
              Add connection
            </Button>
          </div>
        )}
      </div>

      {error && (
        <ErrorMessage title="Could not load connections" message={error} onRetry={() => void load()} className="mt-4" />
      )}

      {showRestImport && (
        <RestImportForm
          onDone={() => {
            setShowRestImport(false);
            void load();
          }}
          onCancel={() => setShowRestImport(false)}
        />
      )}

      {showForm && (
        <CreateConnectorForm
          onDone={() => {
            setShowForm(false);
            toast({
              title: "Connection saved",
              message: "The connection was tested against the live server.",
              type: "success",
            });
            void load();
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      <div className="mt-5">
        <h3 className="text-h3 text-foreground">Your connections</h3>
        {!items ? (
          <LoadingSkeleton rows={2} className="mt-3" />
        ) : items.length === 0 ? (
          <Card className="mt-3">
            <EmptyState
              icon={Database}
              title="No connections yet"
              description="Add a PostgreSQL, mySQL, MongoDB, Snowflake or BigQuery connection above to introspect its schema, preview real rows, and import tables as datasets."
            />
          </Card>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {items.map((connector) => (
              <li key={connector.id}>
                <ConnectorCard
                  connector={connector}
                  onChanged={() => void load()}
                  onError={(message) => {
                    setError(message);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-caption text-muted">
        Operator-configured sources (environment variables):{" "}
        {envStatuses
          .filter((c) => c.configured)
          .map((c) => c.label)
          .join(", ") || "none configured"}
        . Workspace connections above are managed here and stored per-workspace — the two paths are independent.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* REST import form                                                    */
/* ------------------------------------------------------------------ */

interface ProjectOption {
  id: string;
  name: string;
}

function RestImportForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<{ projects: ProjectOption[] }>("/api/projects");
      setProjects(data.projects);
      if (data.projects.length === 1 && !projectId) setProjectId(data.projects[0]?.id ?? "");
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const canImport = Boolean(projectId && url.trim());

  const importSource = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ datasetId: string; rowCount: number }>("/api/connectors/rest/import", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          token: token.trim() || undefined,
          name: name.trim() || undefined,
          projectId,
        }),
      });
      toast({
        title: "Dataset imported",
        message: `${data.rowCount.toLocaleString()} rows pulled from the endpoint into your project.`,
        type: "success",
      });
      onDone();
      router.push(`/datasets/${data.datasetId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <CardContent className="p-5">
        <p className="text-sm font-medium text-foreground">Import from a REST endpoint</p>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The server fetches the URL with your bearer token (delivered over TLS), normalizes CSV / JSON / XLSX payloads,
          and stores the rows as a project dataset through the same pipeline as uploads.
        </p>
        {error && <ErrorMessage title="Could not import the source" message={error} className="mt-3" />}

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Endpoint URL"
            required
            helper="Returns CSV, JSON (array of objects), or XLSX."
            className="md:col-span-2"
          >
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/v1/orders"
              autoComplete="off"
              inputMode="url"
            />
          </Field>
          <Field label="Bearer token" helper="Sent as Authorization: Bearer <token>. Optional for public endpoints.">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Optional access token"
              autoComplete="new-password"
            />
          </Field>
          <Field label="Project" required helper="The dataset is stored inside this project.">
            {projects === null ? (
              <Input disabled placeholder="Loading projects…" />
            ) : projects.length === 0 ? (
              <Input disabled placeholder="Create a project first" />
            ) : (
              <Select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                options={projects.map((project) => ({ value: project.id, label: project.name }))}
                placeholder="Choose a project"
                aria-label="Project"
              />
            )}
          </Field>
          <Field label="Dataset name" helper="Defaults to the endpoint name if left blank.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="orders (live)" />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => void importSource()}
            loading={busy}
            disabled={!canImport || projects === null || projects.length === 0}
            icon={<UploadCloud aria-hidden className="size-4" />}
          >
            Import into dataset
          </Button>
          {projects !== null && projects.length === 0 && (
            <span className="text-caption text-muted">
              You need at least one project — create one, then come back here.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Create form                                                         */
/* ------------------------------------------------------------------ */

interface ConnectorField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "checkbox" | "textarea" | "select";
  required?: boolean;
  helper?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Options for "select" fields. */
  options?: { value: string; label: string }[];
  /** Text configured at the top level, alongside the connector name. */
  topLevel?: boolean;
}

interface KindSpec {
  label: string;
  defaultPort: string;
  fields: ConnectorField[];
}

const KIND_SPECS: Record<string, KindSpec> = {
  postgres: {
    label: "PostgreSQL",
    defaultPort: "5432",
    fields: [
      { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com" },
      { key: "port", label: "Port", type: "number", defaultValue: "5432" },
      { key: "database", label: "Database", type: "text", required: true, placeholder: "warehouse" },
      { key: "user", label: "User", type: "text", required: true, helper: "A read-only role is recommended." },
      { key: "password", label: "Password", type: "password", required: true },
      {
        key: "ssl",
        label: "Use SSL / TLS",
        type: "checkbox",
        helper: "Encrypts the connection to the server. Enable for cloud-hosted databases.",
      },
      {
        key: "schema",
        label: "Schema (optional)",
        type: "text",
        helper: "Defaults to “public”. Only this schema is browsed.",
        placeholder: "public",
      },
    ],
  },
  mysql: {
    label: "mySQL",
    defaultPort: "3306",
    fields: [
      { key: "host", label: "Host", type: "text", required: true, placeholder: "db.example.com" },
      { key: "port", label: "Port", type: "number", defaultValue: "3306" },
      { key: "database", label: "Database", type: "text", required: true, placeholder: "warehouse" },
      { key: "user", label: "User", type: "text", required: true, helper: "A read-only role is recommended." },
      { key: "password", label: "Password", type: "password", helper: "Optional for password-less local roles." },
      {
        key: "ssl",
        label: "Use SSL / TLS",
        type: "checkbox",
        helper: "Encrypts the connection to the server. Enable for cloud-hosted databases.",
      },
      {
        key: "schema",
        label: "Schema (optional)",
        type: "text",
        helper: "Defaults to the database name. Only this schema is browsed.",
        placeholder: "warehouse",
      },
    ],
  },
  mongodb: {
    label: "MongoDB",
    defaultPort: "27017",
    fields: [
      { key: "host", label: "Host", type: "text", required: true, placeholder: "mongodb.example.com" },
      { key: "port", label: "Port", type: "number", defaultValue: "27017" },
      { key: "database", label: "Database", type: "text", required: true, placeholder: "app" },
      { key: "user", label: "User", type: "text", helper: "Optional — leave blank for auth-less deployments." },
      { key: "password", label: "Password", type: "password", helper: "Optional when no user is set." },
      {
        key: "authSource",
        label: "Auth source (optional)",
        type: "text",
        helper: "Database that authenticates the user. Defaults to the database above.",
        placeholder: "admin",
      },
      {
        key: "ssl",
        label: "Use SSL / TLS",
        type: "checkbox",
        helper: "Encrypts the connection to the server. Enable for MongoDB Atlas.",
      },
    ],
  },
  snowflake: {
    label: "Snowflake",
    defaultPort: "",
    fields: [
      { key: "account", label: "Account", type: "text", required: true, placeholder: "acme.eu-central-1.aws" },
      { key: "username", label: "Username", type: "text", required: true },
      { key: "password", label: "Password", type: "password", required: false },
      {
        key: "privateKeyPem",
        label: "Private key (PEM)",
        type: "textarea",
        helper: "Preferred over a password (key-pair auth). Paste the PKCS#8 PEM.",
      },
      { key: "role", label: "Role (optional)", type: "text" },
      { key: "warehouse", label: "Warehouse (optional)", type: "text" },
      { key: "database", label: "Database", type: "text", required: true },
      { key: "schema", label: "Schema", type: "text", required: true, placeholder: "PUBLIC" },
    ],
  },
  bigquery: {
    label: "BigQuery",
    defaultPort: "",
    fields: [
      { key: "projectId", label: "Project ID", type: "text", required: true, placeholder: "my-project" },
      { key: "datasetId", label: "Dataset ID", type: "text", required: true, placeholder: "sources" },
      {
        key: "credentialsJson",
        label: "Service-account credentials JSON",
        type: "textarea",
        required: true,
        helper: "Paste the full key JSON from Google Cloud (IAM → Service Accounts → Keys).",
      },
    ],
  },
  tally: {
    label: "Tally (live gateway)",
    defaultPort: "9000",
    fields: [
      {
        key: "host",
        label: "Tally host",
        type: "text",
        required: true,
        placeholder: "tally.example.com",
        helper:
          "Host of the TallyPrime HTTP server (F1 Help → Settings → Advanced Configuration → enable it; default port 9000). Must be publicly reachable from this server unless CONNECTOR_ALLOW_PRIVATE_URLS=true (self-hosted LAN escape hatch). For exported TCML/CSV files, upload them as datasets instead.",
      },
      { key: "port", label: "Port", type: "number", defaultValue: "9000" },
      {
        key: "company",
        label: "Company name (optional)",
        type: "text",
        helper: "As shown in Tally. Defaults to the active company.",
      },
      {
        key: "fromDate",
        label: "From date (optional)",
        type: "text",
        placeholder: "2025-04-01",
        helper: "Export period start (YYYY-MM-DD). Empty uses Tally's active period.",
      },
      {
        key: "toDate",
        label: "To date (optional)",
        type: "text",
        placeholder: "2026-03-31",
        helper: "Export period end (YYYY-MM-DD). Empty uses Tally's active period.",
      },
    ],
  },
  sheets: {
    label: "Google Sheets",
    defaultPort: "",
    fields: [
      {
        key: "spreadsheetId",
        label: "Spreadsheet ID",
        type: "text",
        required: true,
        placeholder: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
        helper: "The ID from the sheet URL (docs.google.com/spreadsheets/d/<ID>/edit) — not the whole URL.",
      },
      {
        key: "credentialsJson",
        label: "Service-account credentials JSON",
        type: "textarea",
        required: true,
        helper:
          "Paste the full key JSON from Google Cloud (IAM → Service Accounts → Keys), then share the sheet with the service account's email as Viewer.",
      },
    ],
  },
  "onedrive-excel": {
    label: "Excel via OneDrive/SharePoint",
    defaultPort: "",
    fields: [
      {
        key: "source",
        label: "Source",
        type: "select",
        defaultValue: "sharepoint",
        options: [
          { value: "sharepoint", label: "SharePoint document library" },
          { value: "onedrive", label: "OneDrive (personal drive)" },
        ],
      },
      {
        key: "siteHost",
        label: "SharePoint host",
        type: "text",
        placeholder: "contoso.sharepoint.com",
        helper: "SharePoint mode only — the tenant host, not a full URL.",
      },
      {
        key: "filePath",
        label: "Workbook path",
        type: "text",
        required: true,
        placeholder: "/sites/Finance/Reports/sales.xlsx",
        helper: "Server-relative path to the .xlsx file (OneDrive: path under the drive root).",
      },
      {
        key: "tenantId",
        label: "Tenant ID",
        type: "text",
        required: true,
        helper: "Azure AD → App registrations → Overview → Directory (tenant) ID.",
      },
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        required: true,
        helper: "Azure AD → App registrations → Overview → Application (client) ID.",
      },
      {
        key: "clientSecret",
        label: "Client secret",
        type: "password",
        required: true,
        helper: "Azure AD → Certificates & secrets. Stored encrypted; only used to mint short-lived tokens.",
      },
      {
        key: "worksheet",
        label: "Worksheet (optional)",
        type: "text",
        helper: "Defaults to the workbook's first sheet.",
      },
    ],
  },
  "zoho-books": {
    label: "Zoho Books",
    defaultPort: "",
    fields: [
      {
        key: "region",
        label: "Data center",
        type: "select",
        defaultValue: "in",
        options: ZOHO_BOOKS_REGIONS.map((region) => ({ value: region.value, label: region.label })),
        helper: "Must match the data center the token was minted in — Indian accounts are zoho.in.",
      },
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        required: true,
        helper: "Self-client ID from api-console.zoho.com.",
      },
      { key: "clientSecret", label: "Client secret", type: "password", required: true },
      {
        key: "refreshToken",
        label: "Refresh token",
        type: "password",
        required: true,
        helper:
          "Mint with a read-only Books scope (e.g. ZohoBooks.fullaccess.read). Stored encrypted; access tokens are minted per request and never saved.",
      },
      {
        key: "organizationId",
        label: "Organization ID (optional)",
        type: "text",
        helper: "Zoho Books → Settings → Organization. Defaults to the first organization on the account.",
      },
    ],
  },
  "tds-challan": {
    label: "TDS Challan Data",
    defaultPort: "",
    fields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        defaultValue: "csv",
        options: [
          { value: "csv", label: "CSV" },
          { value: "excel", label: "Excel" },
          { value: "json", label: "JSON" },
        ],
      },
      { key: "tan", label: "TAN (optional)", type: "text", placeholder: "AAAA12345B" },
      { key: "financialYear", label: "Financial Year (optional)", type: "text", placeholder: "2024-25" },
      { key: "skipRows", label: "Skip header rows", type: "number", defaultValue: "0" },
    ],
  },
  "payroll-export": {
    label: "Payroll Export",
    defaultPort: "",
    fields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        defaultValue: "csv",
        options: [
          { value: "csv", label: "CSV" },
          { value: "excel", label: "Excel" },
          { value: "json", label: "JSON" },
        ],
      },
      { key: "month", label: "Month (YYYY-MM)", type: "text", placeholder: "2025-04" },
      { key: "system", label: "Payroll System (optional)", type: "text", placeholder: "e.g., greytHR, ADP" },
      { key: "skipRows", label: "Skip header rows", type: "number", defaultValue: "0" },
    ],
  },
  "ims-einvoice": {
    label: "IMS/E-Invoice",
    defaultPort: "",
    fields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        defaultValue: "json",
        options: [
          { value: "json", label: "JSON" },
          { value: "xml", label: "XML" },
          { value: "csv", label: "CSV" },
        ],
      },
      { key: "gstin", label: "GSTIN (optional)", type: "text", placeholder: "22AAAAA0000A1Z5" },
      { key: "period", label: "Period (YYYYMM, optional)", type: "text", placeholder: "202504" },
    ],
  },
  razorpay: {
    label: "Razorpay",
    defaultPort: "",
    fields: [
      { key: "keyId", label: "Key ID", type: "text", required: true },
      { key: "keySecret", label: "Key Secret", type: "password", required: true },
      { key: "webhookSecret", label: "Webhook Secret (optional)", type: "password" },
      {
        key: "accountType",
        label: "Account Type",
        type: "select",
        defaultValue: "standard",
        options: [
          { value: "standard", label: "Standard" },
          { value: "route", label: "Route" },
        ],
      },
    ],
  },
  payu: {
    label: "PayU",
    defaultPort: "",
    fields: [
      { key: "merchantKey", label: "Merchant Key", type: "text", required: true },
      { key: "merchantSalt", label: "Merchant Salt", type: "password", required: true },
      {
        key: "environment",
        label: "Environment",
        type: "select",
        defaultValue: "test",
        options: [
          { value: "test", label: "Test" },
          { value: "production", label: "Production" },
        ],
      },
    ],
  },
  busy: {
    label: "Busy Accounting",
    defaultPort: "",
    fields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        defaultValue: "xml",
        options: [
          { value: "xml", label: "XML" },
          { value: "csv", label: "CSV" },
          { value: "dbf", label: "DBF" },
        ],
      },
      { key: "companyName", label: "Company Name (optional)", type: "text" },
    ],
  },
  marg: {
    label: "Marg ERP",
    defaultPort: "",
    fields: [
      {
        key: "format",
        label: "Format",
        type: "select",
        defaultValue: "xml",
        options: [
          { value: "xml", label: "XML" },
          { value: "csv", label: "CSV" },
          { value: "dbf", label: "DBF" },
        ],
      },
      { key: "companyName", label: "Company Name (optional)", type: "text" },
    ],
  },
};

function CreateConnectorForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState("postgres");
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = KIND_SPECS[kind] ?? KIND_SPECS.postgres!;

  const setField = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  const setCheck = (key: string, value: boolean) => setChecks((prev) => ({ ...prev, [key]: value }));

  const fieldValue = (field: ConnectorField) =>
    field.type === "checkbox" ? undefined : (values[field.key] ?? field.defaultValue ?? "");

  const save = async () => {
    setBusy(true);
    setError(null);
    // Ports are numeric in the config schema; checkboxes are booleans.
    const config: Record<string, unknown> = {};
    for (const field of spec.fields) {
      if (field.topLevel) continue;
      if (field.type === "checkbox") {
        config[field.key] = Boolean(checks[field.key]);
      } else if (field.type === "number") {
        const raw = (values[field.key] ?? "").trim();
        if (raw) config[field.key] = Number(raw);
      } else {
        config[field.key] = (values[field.key] ?? "").trim();
      }
    }
    try {
      await api("/api/connectors", {
        method: "POST",
        body: JSON.stringify({
          kind,
          name: name.trim(),
          config,
        }),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const requiredFilled = spec.fields
    .filter((field) => field.type !== "checkbox" && field.required)
    .every((field) => (values[field.key] ?? "").trim().length > 0);
  const canSave = Boolean(name.trim()) && requiredFilled;

  return (
    <Card className="mt-4">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">New connection</p>
          <Select
            aria-label="Connector kind"
            className="h-9 w-56"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={Object.entries(KIND_SPECS).map(([value, spec]) => ({ value, label: spec.label }))}
          />
        </div>
        {error && <ErrorMessage title="Could not save the connection" message={error} className="mt-3" />}
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Connection name" required helper="A label you will recognise, e.g. “Production warehouse”.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production warehouse" />
          </Field>
          {spec.fields.map((field) =>
            field.type === "checkbox" ? (
              <div key={field.key} className="md:col-span-2">
                <Checkbox
                  label={field.label}
                  description={field.helper}
                  checked={Boolean(checks[field.key])}
                  onChange={(value) => setCheck(field.key, value)}
                />
              </div>
            ) : field.type === "select" ? (
              <Field
                key={field.key}
                label={field.label}
                required={field.required}
                helper={
                  kind === "zoho-books" && field.key === "region"
                    ? (zohoRegionMeta(fieldValue(field) ?? "in")?.hint ?? field.helper)
                    : field.helper
                }
              >
                <Select
                  value={fieldValue(field) ?? ""}
                  onChange={(e) => setField(field.key, e.target.value)}
                  options={field.options ?? []}
                  aria-label={field.label}
                />
              </Field>
            ) : field.type === "textarea" ? (
              <Field
                key={field.key}
                label={field.label}
                required={field.required}
                helper={field.helper}
                className="md:col-span-2"
              >
                <textarea
                  value={fieldValue(field) ?? ""}
                  onChange={(e) => setField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  rows={5}
                  className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            ) : (
              <Field key={field.key} label={field.label} required={field.required} helper={field.helper}>
                <Input
                  type={field.type}
                  value={fieldValue(field) ?? ""}
                  onChange={(e) => setField(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  autoComplete="new-password"
                />
              </Field>
            ),
          )}
        </div>
        <p className="mt-3 text-caption text-muted">
          Saving tests the connection live against the server. Credentials are encrypted at rest and never sent back to
          this page.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!canSave}>
            Test &amp; save connection
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Connector card                                                      */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<ConnectorView["status"], string> = {
  untested: "not tested",
  ok: "connected",
  error: "error",
};

/** Live metadata returned by a successful test (real server version + latency). */
interface TestMeta {
  serverVersion: string;
  latencyMs: number;
  database: string;
}

function ConnectorCard({
  connector,
  onChanged,
  onError,
}: {
  connector: ConnectorView;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [detail, setDetail] = useState<ConnectorView>(connector);
  const [tables, setTables] = useState<ConnectorTableInfo[] | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [selected, setSelected] = useState<TableSelection | null>(null);
  const [sample, setSample] = useState<ConnectorSample | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<TestMeta | null>(null);
  const [runs, setRuns] = useState<ConnectorSyncRunView[] | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(connector.syncEnabled);
  const [syncCron, setSyncCron] = useState(connector.syncCron ?? "0 9 * * *");

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusyAction(label);
    try {
      await fn();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusyAction(null);
    }
  };

  const loadDetail = async () => {
    const data = await api<{ connector: ConnectorView }>(`/api/connectors/${connector.id}`);
    setDetail(data.connector);
  };

  const test = () =>
    act("test", async () => {
      const res = await api<{ ok: boolean; meta: TestMeta | null; message?: string }>(
        `/api/connectors/${connector.id}/test`,
        { method: "POST", body: "{}" },
      );
      if (res.ok && res.meta) {
        setLastTest(res.meta);
        toast({
          title: "Connection works",
          message: `${res.meta.database} answered in ${res.meta.latencyMs} ms (${res.meta.serverVersion}).`,
          type: "success",
        });
      } else {
        // Honest result: no live engine for this kind — say exactly that.
        setLastTest(null);
        toast({
          title: "Not connected",
          message: res.message ?? "The connection could not be verified.",
          type: "error",
        });
      }
      onChanged();
    });

  const remove = async () => {
    const ok = await confirm({
      title: `Delete connection “${connector.name}”?`,
      message: "The stored credentials and sync schedule will be removed.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    await act("delete", async () => {
      await api(`/api/connectors/${connector.id}`, { method: "DELETE" });
      toast({ title: "Connection deleted", message: `“${connector.name}” was removed.`, type: "success" });
      onChanged();
    });
  };

  const openBrowse = () =>
    act("browse", async () => {
      setBrowsing(true);
      await loadDetail();
      const data = await api<{ tables: ConnectorTableInfo[] }>(`/api/connectors/${connector.id}/tables`);
      setTables(data.tables);
      const history = await api<{ runs: ConnectorSyncRunView[] }>(`/api/connectors/${connector.id}/syncs`);
      setRuns(history.runs);
    });

  const preview = (schema: string, table: string, limit: number) =>
    act("preview", async () => {
      setSelected({ schema, name: table });
      setSampleError(null);
      try {
        const data = await api<ConnectorSample>(
          `/api/connectors/${connector.id}/sample?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&limit=${limit}`,
        );
        setSample(data);
        if ((data as { error?: string }).error) setSampleError((data as { error?: string }).error ?? null);
      } catch (err) {
        setSampleError(errorMessage(err));
        setSample(null);
      }
    });

  const saveSchedule = () =>
    act("schedule", async () => {
      await api(`/api/connectors/${connector.id}`, {
        method: "PATCH",
        body: JSON.stringify({ syncEnabled, syncCron: syncEnabled ? syncCron.trim() : null }),
      });
      toast({ title: syncEnabled ? "Scheduled sync enabled" : "Scheduled sync disabled", type: "success" });
      onChanged();
    });

  const imported = detail.importedDatasets;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="flex size-9 items-center justify-center rounded-md bg-accent/12 text-accent">
          <Database className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{connector.name}</p>
          <p className="text-caption text-muted">
            {connector.kind} · last tested{" "}
            {connector.lastTestedAt ? new Date(connector.lastTestedAt).toLocaleString() : "never"}
            {connector.lastSyncAt ? ` · last sync ${new Date(connector.lastSyncAt).toLocaleString()}` : ""}
          </p>
          {connector.lastError && (
            <p className="mt-1 max-w-3xl text-caption text-danger" role="alert">
              {connector.lastError}
            </p>
          )}
        </div>
        <Badge variant={connector.status === "ok" ? "success" : connector.status === "error" ? "warning" : "outline"}>
          {STATUS_LABEL[connector.status]}
        </Badge>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void test()}
            loading={busyAction === "test"}
            icon={<RefreshCw aria-hidden className="size-3.5" />}
          >
            Test
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void openBrowse()}
            loading={busyAction === "browse"}
            icon={<Search aria-hidden className="size-3.5" />}
          >
            {browsing ? "Close schema" : "Browse schema"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete connection ${connector.name}`}
            onClick={() => void remove()}
            loading={busyAction === "delete"}
          >
            <Trash2 aria-hidden className="size-4 text-muted hover:text-danger" />
          </Button>
        </div>
      </div>

      {lastTest && (
        <p className="mt-2 text-caption text-muted" role="status">
          Last test: {lastTest.database} answered in {lastTest.latencyMs} ms · {lastTest.serverVersion}
        </p>
      )}

      {imported.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Imported datasets ({imported.length})</p>
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                act("sync", async () => {
                  await api(`/api/connectors/${connector.id}/sync`, { method: "POST", body: JSON.stringify({}) });
                  toast({
                    title: "Sync complete",
                    message: "The datasets were re-pulled and versioned.",
                    type: "success",
                  });
                  onChanged();
                  await loadDetail();
                })
              }
              loading={busyAction === "sync"}
              icon={<RefreshCw aria-hidden className="size-3" />}
            >
              Sync all now
            </Button>
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {imported.map((dataset) => (
              <li
                key={dataset.id}
                className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
              >
                <span className="font-medium text-foreground">{dataset.name}</span>
                <span className="text-caption text-muted">{dataset.rowCount.toLocaleString()} rows</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    act("sync-one", async () => {
                      await api(`/api/connectors/${connector.id}/sync`, {
                        method: "POST",
                        body: JSON.stringify({ datasetId: dataset.id }),
                      });
                      toast({
                        title: "Synced",
                        message: `“${dataset.name}” was re-pulled and versioned.`,
                        type: "success",
                      });
                      onChanged();
                      await loadDetail();
                    })
                  }
                  loading={busyAction === "sync-one"}
                  icon={<RefreshCw aria-hidden className="size-3" />}
                  aria-label={`Sync dataset ${dataset.name}`}
                >
                  Sync
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <Checkbox
          label="Scheduled sync"
          description="Re-pull imported datasets on a schedule and record a versioned run with a change log."
          checked={syncEnabled}
          onChange={setSyncEnabled}
        />
        {syncEnabled && (
          <>
            <Select
              aria-label="Sync schedule preset"
              className="h-8 w-52"
              value={syncCron}
              onChange={(e) => setSyncCron(e.target.value)}
              options={SYNC_PRESETS.map((preset) => ({ value: preset.cron, label: preset.label }))}
              placeholder="Custom: minute hour day month weekday"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void saveSchedule()}
              loading={busyAction === "schedule"}
            >
              Save schedule
            </Button>
            {connector.nextSyncAt && (
              <span className="text-caption text-muted">
                Next run {new Date(connector.nextSyncAt).toLocaleString()}
              </span>
            )}
          </>
        )}
      </div>

      {browsing && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-medium text-foreground">Schema</p>
            {tables && tables.length > 5 && (
              <Input
                aria-label="Filter tables"
                placeholder="Filter tables…"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                className="h-8 w-56"
              />
            )}
          </div>
          {sampleError && (
            <p className="mt-2 text-caption text-danger" role="alert">
              {sampleError}
            </p>
          )}
          {!tables ? (
            <LoadingSkeleton rows={2} className="mt-2" />
          ) : tables.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No tables were found — check the user&apos;s read permissions.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {tables
                .filter((table) => {
                  const q = tableFilter.trim().toLowerCase();
                  if (!q) return true;
                  const fullName = `${table.schema}.${table.name}`.toLowerCase();
                  return fullName.includes(q) || table.columns.some((column) => column.name.toLowerCase().includes(q));
                })
                .map((table) => {
                  const fullName = `${table.schema}.${table.name}`;
                  const isSelected = selected?.schema === table.schema && selected?.name === table.name;
                  return (
                    <li key={fullName} className="rounded-md border border-line bg-surface p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] font-medium text-foreground">{fullName}</span>
                        <span className="text-caption text-muted">{table.columns.length} column(s)</span>
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => void preview(table.schema, table.name, 100)}
                          loading={busyAction === "preview" && isSelected}
                        >
                          Preview rows
                        </Button>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {table.columns.map((column) => (
                          <Badge key={column.name} variant="outline" title={column.dataType}>
                            {column.name}
                          </Badge>
                        ))}
                      </div>
                      {isSelected && sample && (
                        <TableImportRow
                          connectorId={connector.id}
                          selection={selected}
                          sample={sample}
                          onImported={() => {
                            setSample(null);
                            setSelected(null);
                            onChanged();
                          }}
                          onError={onError}
                        />
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}

      {runs && runs.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-sm font-medium text-foreground">Recent sync runs</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {runs.slice(0, 5).map((run) => (
              <li key={run.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={run.status === "SUCCESS" ? "success" : run.status === "ERROR" ? "warning" : "outline"}>
                  {run.status === "SUCCESS" ? "ok" : run.status === "ERROR" ? "failed" : "running"}
                </Badge>
                <span className="text-muted">
                  {run.tableName} · {run.rowCount?.toLocaleString() ?? "—"} rows ·{" "}
                  {run.triggeredBy === "schedule" ? "scheduled" : "manual"} · {new Date(run.startedAt).toLocaleString()}
                </span>
                {run.changeLog && <ChangeLogNote log={run.changeLog} />}
                {run.error && <span className="text-caption text-danger">{run.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ChangeLogNote({ log }: { log: ConnectorChangeLog }) {
  if (log.rowsAdded === 0 && log.rowsRemoved === 0) {
    return <span className="text-caption text-muted">no changes</span>;
  }
  return (
    <span className="text-caption text-muted">
      +{log.rowsAdded.toLocaleString()} / −{log.rowsRemoved.toLocaleString()} rows
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Import row (sample preview + import action)                        */
/* ------------------------------------------------------------------ */

function TableImportRow({
  connectorId,
  selection,
  sample: initialSample,
  onImported,
  onError,
}: {
  connectorId: string;
  selection: TableSelection;
  sample: ConnectorSample;
  onImported: () => void;
  onError: (message: string) => void;
}) {
  const [limit, setLimit] = useState("100");
  const [name, setName] = useState(`${selection.name} import`);
  const [sample, setSample] = useState<ConnectorSample>(initialSample);
  const [importing, setImporting] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);

  const refreshPreview = async () => {
    setPreviewBusy(true);
    try {
      const data = await api<ConnectorSample>(
        `/api/connectors/${connectorId}/sample?schema=${encodeURIComponent(selection.schema)}&table=${encodeURIComponent(selection.name)}&limit=${Number(limit)}`,
      );
      setSample(data);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setPreviewBusy(false);
    }
  };

  const importTable = async () => {
    setImporting(true);
    try {
      await api(`/api/connectors/${connectorId}/import`, {
        method: "POST",
        body: JSON.stringify({
          schema: selection.schema,
          table: selection.name,
          name: name.trim() || `${selection.name} import`,
          limit: Number(limit),
        }),
      });
      onImported();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const columns = (sample?.columns ?? []).map((column) => ({
    key: column.name,
    label: column.name,
    format: (column.colType === "number" ? "number" : column.colType === "date" ? "date" : "text") as
      "number" | "date" | "text",
  }));

  return (
    <div className="mt-3 rounded-md border border-line bg-background p-3">
      <div className="flex flex-wrap items-end gap-3">
        <p className="text-sm font-medium text-foreground">
          Preview — {sample.rowCount.toLocaleString()} row(s) in source
        </p>
        <Select
          aria-label="Sample size"
          className="h-8 w-36"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          options={SAMPLE_LIMITS}
        />
        <Button size="sm" variant="secondary" onClick={() => void refreshPreview()} loading={previewBusy}>
          Refresh preview
        </Button>
      </div>
      <div className="mt-2 max-h-64 overflow-auto">
        <DataTable columns={columns} rows={(sample?.rows ?? []) as (string | number | null)[][]} pageSize={10} />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Dataset name" className="min-w-56">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button
          onClick={() => void importTable()}
          loading={importing}
          icon={<UploadCloud aria-hidden className="size-4" />}
        >
          Import as dataset
        </Button>
        <p className="text-caption text-muted">
          Imports up to {Number(limit).toLocaleString()} rows through the same pipeline as uploads.
        </p>
      </div>
    </div>
  );
}

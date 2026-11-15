/**
 * Connector error handling.
 *
 * Every failure from a live connection is mapped to a clean message that names
 * what happened and how to fix it — never a raw driver stack trace, and never
 * a credential. `friendlyPgError` classifies node-postgres failures by their
 * SQLSTATE / Node error code so the UI can show the right guidance.
 */

export class ConnectorError extends Error {
  status: number;
  code: string;

  constructor(message: string, opts: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.status = opts.status ?? 400;
    this.code = opts.code ?? "CONNECTOR_ERROR";
  }
}

/** Map a node-postgres / network failure to a clean, credential-free message. */
export function friendlyPgError(err: unknown, destination?: string): ConnectorError {
  const code = (err as { code?: string })?.code;
  const detail = (err as { detail?: string })?.detail;
  const dest = destination ? ` at ${destination}` : "";

  switch (code) {
    case "28P01":
      return new ConnectorError(
        `PostgreSQL rejected the password for this user. What happened: authentication failed${dest}. How to fix: check the user and password in this connection, then save and test again.`,
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    case "28000":
      return new ConnectorError(
        `The database user is not allowed to connect${dest}. What happened: authorization failed. How to fix: verify the user has CONNECT permission on the database.`,
        { status: 401, code: "CONNECTOR_AUTH" },
      );
    case "3D000":
      return new ConnectorError(
        `The database “${safeDetail(detail, "…")}” does not exist. What happened: the database name in this connection is wrong${dest}. How to fix: check the database name and retry.`,
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    case "42501":
      return new ConnectorError(
        `The connected user lacks permission to read this schema or table. What happened: permission denied. How to fix: grant SELECT on the source objects to the database user, then retry.`,
        { status: 403, code: "CONNECTOR_PERMISSION" },
      );
    case "42P01":
      return new ConnectorError(
        `The table or view does not exist. What happened: undefined table. How to fix: refresh the schema list and choose an existing table.`,
        { status: 404, code: "CONNECTOR_NOT_FOUND" },
      );
    case "ECONNREFUSED":
      return new ConnectorError(
        `Could not reach the database${dest}. What happened: the connection was refused — the server may be down or the port wrong. How to fix: confirm host and port, and that the database accepts TCP connections.`,
        { status: 502, code: "CONNECTOR_UNREACHABLE" },
      );
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
      return new ConnectorError(
        `The connection timed out${dest}. What happened: the database did not answer in time. How to fix: check network access and firewall rules, then retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    case "08006":
      return new ConnectorError(
        `The connection to the database was lost. What happened: connection failure${dest}. How to fix: confirm the server is running and retry.`,
        { status: 502, code: "CONNECTOR_UNREACHABLE" },
      );
    case "57014":
      return new ConnectorError(
        `The query was cancelled because it ran too long. What happened: statement timeout. How to fix: import fewer rows or a smaller table, then retry.`,
        { status: 504, code: "CONNECTOR_TIMEOUT" },
      );
    default:
      return new ConnectorError(
        `The database request failed. What happened: ${shortMessage(err)}. How to fix: review the connection settings and the source objects, then retry.`,
        { status: 400, code: "CONNECTOR_ERROR" },
      );
  }
}

function safeDetail(detail: string | undefined, fallback: string): string {
  return detail && detail.length < 120 ? detail : fallback;
}

function shortMessage(err: unknown): string {
  const message = (err as { message?: string })?.message ?? "unknown error";
  // First sentence only — enough context, no stack.
  const firstSentence = message.split(/\.\s+|\n/)[0] ?? message;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}…` : firstSentence;
}

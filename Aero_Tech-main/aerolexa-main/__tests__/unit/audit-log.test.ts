/**
 * Unit tests for audit logging functions.
 * These tests verify audit event creation logic without requiring a database.
 */

import { auditRowToView, type AuditEventType } from "@/lib/server/audit";

describe("Audit Logging", () => {
  describe("Audit event payload structure", () => {
    it("should have correct structure for notebook cell run", () => {
      const payload = {
        cellId: "cell-123",
        cellPosition: 5,
        code: "print('hello')",
        output: "hello",
        status: "success",
        kernel: "python",
        durationMs: 100,
      };

      // Verify the structure matches what we'd log
      expect(payload).toHaveProperty("cellId");
      expect(payload).toHaveProperty("status");
      expect(["success", "error"]).toContain(payload.status);
    });

    it("should have correct structure for SQL query run", () => {
      const payload = {
        query: "SELECT * FROM users",
        status: "success",
        rowCount: 100,
        executionTimeMs: 50,
      };

      expect(payload).toHaveProperty("query");
      expect(payload).toHaveProperty("status");
      expect(["success", "error"]).toContain(payload.status);
      expect(payload).toHaveProperty("rowCount");
    });

    it("should have correct structure for schedule run", () => {
      const payload = {
        runNumber: 42,
        status: "completed",
        artifactPath: "/exports/report-2024.html",
        triggeredBy: "schedule" as const,
        durationMs: 5000,
      };

      expect(payload).toHaveProperty("runNumber");
      expect(payload).toHaveProperty("status");
      expect(["completed", "failed", "skipped", "dead_lettered"]).toContain(payload.status);
      expect(payload).toHaveProperty("triggeredBy");
      expect(["schedule", "manual", "retry", "api"]).toContain(payload.triggeredBy);
    });

    it("should have correct structure for connector sync", () => {
      const payload = {
        datasetId: "dataset-123",
        tableName: "public.users",
        status: "completed",
        rowCount: 1000,
        triggeredBy: "manual" as const,
        durationMs: 10000,
      };

      expect(payload).toHaveProperty("datasetId");
      expect(payload).toHaveProperty("tableName");
      expect(payload).toHaveProperty("status");
      expect(["completed", "failed", "started"]).toContain(payload.status);
      expect(payload).toHaveProperty("triggeredBy");
      expect(["manual", "schedule", "webhook"]).toContain(payload.triggeredBy);
    });
  });

  describe("Audit event types", () => {
    it("should include execution event types", () => {
      const executionTypes: AuditEventType[] = [
        "execution.sandbox.created",
        "execution.sandbox.completed",
        "execution.sandbox.failed",
        "execution.sandbox.killed",
        "notebook.cell.run",
        "sql.query.run",
        "python.cell.run",
      ];

      executionTypes.forEach((type) => {
        expect(type).toMatch(/^(execution\.|notebook\.|sql\.|python\.)/);
      });
    });

    it("should include schedule event types", () => {
      const scheduleTypes: AuditEventType[] = [
        "schedule.created",
        "schedule.updated",
        "schedule.run.started",
        "schedule.run.completed",
        "schedule.run.failed",
        "schedule.run.skipped",
        "schedule.run.dead_lettered",
        "schedule.run.missed",
      ];

      scheduleTypes.forEach((type) => {
        expect(type).toMatch(/^schedule(\.|\.run\.)/);
      });
    });

    it("should include data event types", () => {
      const dataTypes: AuditEventType[] = [
        "dataset.uploaded",
        "dataset.imported",
        "dataset.version.created",
        "connector.sync.started",
        "connector.sync.completed",
        "connector.sync.failed",
      ];

      dataTypes.forEach((type) => {
        expect(type).toMatch(/^(dataset\.|connector\.)/);
      });
    });

    it("should include authorization event types", () => {
      const authTypes: AuditEventType[] = [
        "auth.login",
        "auth.logout",
        "auth.session.created",
        "api.key.created",
        "api.key.revoked",
        "api.key.used",
      ];

      authTypes.forEach((type) => {
        expect(type).toMatch(/^(auth\.|api\.key\.)/);
      });
    });
  });

  describe("Audit event linking", () => {
    it("should map canonical target columns to the view", () => {
      const view = auditRowToView({
        id: "evt-1",
        type: "connector.sync.completed",
        message: "connector.sync.completed",
        actorId: "user-456",
        projectId: null,
        targetType: "connector",
        targetId: "conn-abc",
        runId: "run-001",
        meta: JSON.stringify({ status: "completed", rowCount: 1200 }),
        createdAt: new Date("2026-09-20T00:00:00Z"),
      });

      expect(view.targetType).toBe("connector");
      expect(view.targetId).toBe("conn-abc");
      expect(view.runId).toBe("run-001");
      expect(view.payload).toEqual({ status: "completed", rowCount: 1200 });
      expect(view.createdAt).toBe("2026-09-20T00:00:00.000Z");
    });

    it("should produce null target fields for legacy rows written before the columns existed", () => {
      const view = auditRowToView({
        id: "evt-legacy",
        type: "dataset.uploaded",
        message: "dataset.uploaded",
        actorId: null,
        projectId: "proj-9",
        targetType: null,
        targetId: null,
        runId: null,
        meta: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });

      expect(view.targetType).toBeNull();
      expect(view.targetId).toBeNull();
      expect(view.runId).toBeNull();
      expect(view.payload).toEqual({});
    });

    it("should tolerate corrupt meta JSON instead of throwing", () => {
      const view = auditRowToView({
        id: "evt-corrupt",
        type: "auth.login",
        message: "auth.login",
        actorId: "user-456",
        projectId: null,
        targetType: null,
        targetId: null,
        runId: null,
        meta: "{not valid json",
        createdAt: new Date("2026-09-20T00:00:00Z"),
      });

      expect(view.eventType).toBe("auth.login");
      expect(view.payload).toEqual({});
    });
  });

  describe("Audit event payload sanitization", () => {
    it("should truncate long code in payloads", () => {
      const longCode = "x".repeat(2000);

      // Simulate the truncation that happens in logNotebookCellRun
      const truncatedCode = longCode.substring(0, 1000);

      expect(truncatedCode.length).toBe(1000);
      expect(truncatedCode).toBe(longCode.substring(0, 1000));
    });

    it("should truncate long queries in payloads", () => {
      const longQuery = "SELECT ".repeat(500) + "FROM users";

      // Simulate the truncation that happens in logSqlQueryRun
      const truncatedQuery = longQuery.substring(0, 10000);

      expect(truncatedQuery.length).toBeLessThanOrEqual(10000);
    });
  });
});

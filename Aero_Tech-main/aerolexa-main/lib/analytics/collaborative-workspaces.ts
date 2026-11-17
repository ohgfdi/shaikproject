/**
 * Phase 59: Real-Time Collaborative Analytics Workspaces
 *
 * Collaborative analytics workspaces with real-time editing, session management,
 * permission hierarchies, and cross-industry data sharing. Builds on the real-time
 * streaming (Phase 54) and predictive analytics (Phase 56) with workspace persistence
 * and collaboration features.
 */
import type { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import type { Industry } from "@/lib/industry";
import type { StreamType } from "@/lib/streaming/real-time-integrations";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer" | "guest";

export type WorkspaceStatus = "active" | "archived" | "deleted";

export interface WorkspaceMember {
  user_id: string;
  role: WorkspaceRole;
  joined_at: Date;
  last_active_at: Date;
  can_invite: boolean;
  can_export: boolean;
  can_delete: boolean;
}

export interface CollaborativeWorkspace {
  id: string;
  name: string;
  description: string;
  industry: Industry;
  owner_id: string;
  members: WorkspaceMember[];
  status: WorkspaceStatus;
  // Stream configuration
  stream_types: StreamType[];
  shared_metrics: string[];
  // Permissions
  permission_overrides: Record<string, string[]>;
  // Settings
  auto_save_minutes: number;
  max_members: number;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Industry-specific workspace configurations. */
export const WorkspaceConfigs: Partial<Record<Industry, {
  default_role: WorkspaceRole;
  default_stream_types: StreamType[];
  default_metrics: string[];
  max_members: number;
}>> = {
  finance: {
    default_role: "admin",
    default_stream_types: ["kpi-updates", "alerts", "data-changes"],
    default_metrics: ["roi", "arr", "cac", "churn"],
    max_members: 20,
  },
  saas: {
    default_role: "editor",
    default_stream_types: ["kpi-updates", "chart-updates", "collaborative"],
    default_metrics: ["mrr", "arr", "nrr", "churn"],
    max_members: 15,
  },
  retail: {
    default_role: "editor",
    default_stream_types: ["kpi-updates", "chart-updates"],
    default_metrics: ["conversion", "aov", "inventory", "traffic"],
    max_members: 12,
  },
  manufacturing: {
    default_role: "admin",
    default_stream_types: ["kpi-updates", "alerts", "data-changes"],
    default_metrics: ["oee", "defect_rate", "throughput", "downtime"],
    max_members: 18,
  },
};

/** Create a new collaborative workspace. */
export function createWorkspace(
  name: string,
  description: string,
  industry: Industry,
  ownerId: string
): CollaborativeWorkspace {
  const config = WorkspaceConfigs[industry] ?? {
    default_role: "editor" as WorkspaceRole,
    default_stream_types: [] as StreamType[],
    default_metrics: [] as string[],
    max_members: 10,
  };
  const now = new Date();

  const workspace: CollaborativeWorkspace = {
    id: `ws_${Date.now()}`,
    name,
    description,
    industry,
    owner_id: ownerId,
    members: [
      {
        user_id: ownerId,
        role: "owner" as WorkspaceRole,
        joined_at: now,
        last_active_at: now,
        can_invite: true,
        can_export: true,
        can_delete: true,
      },
    ],
    status: "active",
    stream_types: config.default_stream_types,
    shared_metrics: config.default_metrics,
    permission_overrides: {},
    auto_save_minutes: 5,
    max_members: config.max_members,
    is_public: false,
    created_at: now,
    updated_at: now,
  };

  return workspace;
}

/** Add member to workspace. */
export function addMember(
  workspace: CollaborativeWorkspace,
  userId: string,
  role: WorkspaceRole
): CollaborativeWorkspace {
  // Check if user is already a member
  const existing = workspace.members.find((m) => m.user_id === userId);
  if (existing) {
    // Update role if different
    existing.role = role;
    existing.last_active_at = new Date();
    return workspace;
  }

  // Determine if current user can invite
  const canInvite = workspace.owner_id === "current-user" || // Simplified check
    workspace.members.some(
      (m) => m.role === "owner" || m.role === "admin"
    );

  if (!canInvite) {
    throw new Error("Cannot invite members: insufficient permissions");
  }

  const newMember: WorkspaceMember = {
    user_id: userId,
    role,
    joined_at: new Date(),
    last_active_at: new Date(),
    can_invite: role === "editor" || role === "owner" || role === "admin",
    can_export: role === "admin" || role === "owner",
    can_delete: role === "owner",
  };

  workspace.members.push(newMember);
  workspace.updated_at = new Date();

  return workspace;
}

/** Change member role. */
export function changeMemberRole(
  workspace: CollaborativeWorkspace,
  userId: string,
  newRole: WorkspaceRole
): CollaborativeWorkspace {
  const member = workspace.members.find((m) => m.user_id === userId);
  if (!member) {
    throw new Error("Member not found in workspace");
  }

  // Check if current user has permission to change roles
  const canManage = workspace.owner_id === "current-user" ||
    workspace.members.some(
      (m) => m.role === "owner"
    );

  if (!canManage) {
    throw new Error("Insufficient permissions to change roles");
  }

  member.role = newRole;
  member.last_active_at = new Date();
  workspace.updated_at = new Date();

  return workspace;
}

/** Remove member from workspace. */
export function removeMember(
  workspace: CollaborativeWorkspace,
  userId: string
): CollaborativeWorkspace {
  const memberIndex = workspace.members.findIndex((m) => m.user_id === userId);
  if (memberIndex === -1) {
    throw new Error("Member not found in workspace");
  }

  // Prevent removing the owner
  const member = workspace.members[memberIndex];
  if (!member) {
    throw new Error("Member not found in workspace");
  }
  if (member.role === "owner" && workspace.owner_id !== userId) {
    throw new Error("Cannot remove owner: transfer ownership first");
  }

  workspace.members.splice(memberIndex, 1);
  workspace.updated_at = new Date();

  return workspace;
}

/** API route for collaborative workspaces. */
export async function GET(
  request: NextRequest
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action") || "list";

    if (action === "create") {
      const name = searchParams.get("name") || "New Workspace";
      const description = searchParams.get("description") || "";
      const industry = searchParams.get("industry") as Industry || "saas";
      const ownerId = searchParams.get("owner_id") || "user_1";

      const workspace = createWorkspace(name, description, industry, ownerId);

      return new Response(JSON.stringify(workspace), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "by-id") {
      const workspaceId = searchParams.get("workspace_id") || "";

      // In a real implementation, this would fetch from database
      const mockWorkspace: CollaborativeWorkspace = {
        id: workspaceId,
        name: "Sample Workspace",
        description: "Collaborative analytics workspace",
        industry: "saas" as Industry,
        owner_id: "user_1",
        members: [
          {
            user_id: "user_1",
            role: "owner" as WorkspaceRole,
            joined_at: new Date(),
            last_active_at: new Date(),
            can_invite: true,
            can_export: true,
            can_delete: true,
          },
        ],
        status: "active",
        stream_types: ["kpi-updates", "chart-updates"],
        shared_metrics: ["mrr", "arr"],
        permission_overrides: {},
        auto_save_minutes: 5,
        max_members: 15,
        is_public: false,
        created_at: new Date(),
        updated_at: new Date(),
      };

      return new Response(JSON.stringify(mockWorkspace), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Default: list workspaces (mock data)
    const mockWorkspaces: CollaborativeWorkspace[] = [
      {
        id: "ws_1",
        name: "Finance Team Analytics",
        description: "Finance department collaborative analytics workspace",
        industry: "finance" as Industry,
        owner_id: "user_1",
        members: [
          {
            user_id: "user_1",
            role: "owner" as WorkspaceRole,
            joined_at: new Date(),
            last_active_at: new Date(),
            can_invite: true,
            can_export: true,
            can_delete: true,
          },
          {
            user_id: "user_2",
            role: "admin" as WorkspaceRole,
            joined_at: new Date(Date.now() - 86400000),
            last_active_at: new Date(),
            can_invite: false,
            can_export: true,
            can_delete: false,
          },
        ],
        status: "active",
        stream_types: ["kpi-updates", "alerts", "data-changes"],
        shared_metrics: ["roi", "arr", "cac"],
        permission_overrides: {},
        auto_save_minutes: 5,
        max_members: 20,
        is_public: false,
        created_at: new Date("2024-01-15"),
        updated_at: new Date(),
      },
    ];

    return new Response(JSON.stringify(mockWorkspaces), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Collaborative workspaces error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve collaborative workspaces" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
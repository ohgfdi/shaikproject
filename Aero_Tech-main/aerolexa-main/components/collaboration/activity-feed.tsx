/**
 * Phase 13: Activity Feed Component
 *
 * Real-time activity feed showing recent actions across the workspace.
 * Supports filtering by type and user.
 */
import Image from "next/image";
import React, { useCallback, useEffect, useState } from "react";

import { prisma } from "@/lib/db";

export interface ActivityEvent {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  action: "sign_in" | "widget_click" | "report_export" | "comment_added" | "dataset_upload" | "analysis_created";
  targetType: "dataset" | "analysis" | "dashboard" | "book" | "user";
  targetId: string;
  details?: string;
  createdAt: Date;
}

export interface ActivityFeedProps {
  workspaceId: string;
  filter?: "all" | "sign_in" | "widget_click" | "report_export" | "comment_added";
  limit?: number;
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  workspaceId,
  filter = "all",
  limit = 20,
}) => {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    setLoading(true);

    try {
      const where = {
        ...(workspaceId && { workspaceId }),
        ...(filter !== "all" && { type: filter }),
      };

      const data = await prisma.activity.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: {
          actor: {
            select: {
              name: true,
            },
          },
        },
      });

      setEvents(
        data.map((event) => ({
          id: event.id,
          userId: event.actorId ?? "system",
          userName: event.actor?.name || "System",
          userAvatar: undefined,
          action: event.type as ActivityEvent["action"],
          targetType: (event.targetType ?? "dashboard") as ActivityEvent["targetType"],
          targetId: event.targetId ?? "",
          details: event.meta ?? undefined,
          createdAt: event.createdAt,
        }))
      );
    } catch (error) {
      console.error("Failed to fetch activity feed:", error);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filter, limit]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  if (loading) {
    return <div className="activity-loading">Loading activity...</div>;
  }

  if (events.length === 0) {
    return <div className="activity-empty">No activity yet.</div>;
  }

  return (
    <div className="activity-feed">
      <div className="activity-header">
        <span className="activity-count">
          {events.length} recent actions
        </span>
      </div>

      <div className="activity-list">
        {events.map((event) => (
          <div
            key={event.id}
            className="activity-item"
            onClick={() => {
              // TODO: Navigate to target
            }}
          >
            <Image
              src={event.userAvatar || "/avatars/default.png"}
              alt={event.userName}
              className="activity-avatar"
              width={32}
              height={32}
              unoptimized
            />
            <span className="activity-user">{event.userName}</span>
            <span className="activity-action">
              {formatAction(event.action)}
            </span>
            <span className="activity-time">
              {new Date(event.createdAt).toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Format action type to human-readable text. */
function formatAction(action: string): string {
  const actions: Record<string, string> = {
    sign_in: "signed in",
    widget_click: "clicked widget",
    report_export: "exported report",
    comment_added: "added comment",
    dataset_upload: "uploaded dataset",
    analysis_created: "created analysis",
  };
  return actions[action] || action;
}
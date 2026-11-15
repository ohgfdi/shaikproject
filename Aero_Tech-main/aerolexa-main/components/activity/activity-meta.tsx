import {
  BarChart3,
  FileUp,
  FlaskConical,
  FolderPlus,
  LayoutDashboard,
  MessageSquareText,
  PencilRuler,
  Presentation,
  Sparkles,
  Trash2,
} from "lucide-react";

export const ACTIVITY_META: Record<string, { color: string; bg: string; icon: typeof FileUp }> = {
  PROJECT_CREATED: { color: "#5AA8AA", bg: "rgba(90,168,170,0.16)", icon: FolderPlus },
  PROJECT_UPDATED: { color: "#5AA8AA", bg: "rgba(90,168,170,0.16)", icon: FolderPlus },
  PROJECT_ARCHIVED: { color: "#9CA3AF", bg: "rgba(156,163,175,0.16)", icon: FolderPlus },
  DATASET_UPLOADED: { color: "#3D9BE9", bg: "rgba(61,155,233,0.16)", icon: FileUp },
  DATASET_UPDATED: { color: "#3D9BE9", bg: "rgba(61,155,233,0.16)", icon: FileUp },
  ANALYSIS_RUN: { color: "#7C5CFF", bg: "rgba(124,92,255,0.16)", icon: FlaskConical },
  INSIGHTS_GENERATED: { color: "#FFB400", bg: "rgba(255,180,0,0.16)", icon: Sparkles },
  DASHBOARD_CREATED: { color: "#58B368", bg: "rgba(88,179,104,0.16)", icon: LayoutDashboard },
  DASHBOARD_UPDATED: { color: "#58B368", bg: "rgba(88,179,104,0.16)", icon: LayoutDashboard },
  REPORT_CREATED: { color: "#F08A5D", bg: "rgba(240,138,93,0.16)", icon: PencilRuler },
  REPORT_UPDATED: { color: "#F08A5D", bg: "rgba(240,138,93,0.16)", icon: PencilRuler },
  REPORT_EXPORTED: { color: "#F08A5D", bg: "rgba(240,138,93,0.16)", icon: PencilRuler },
  PRESENTATION_CREATED: { color: "#E8637A", bg: "rgba(232,99,122,0.16)", icon: Presentation },
  PRESENTATION_UPDATED: { color: "#E8637A", bg: "rgba(232,99,122,0.16)", icon: Presentation },
  PRESENTATION_EXPORTED: { color: "#E8637A", bg: "rgba(232,99,122,0.16)", icon: Presentation },
  ADVISOR_ASKED: { color: "#5AA8AA", bg: "rgba(90,168,170,0.16)", icon: MessageSquareText },
  ARTIFACT_DELETED: { color: "#E8637A", bg: "rgba(232,99,122,0.14)", icon: Trash2 },
};

export function activityMeta(type: string) {
  return ACTIVITY_META[type] ?? { color: "#9CA3AF", bg: "rgba(156,163,175,0.14)", icon: BarChart3 };
}

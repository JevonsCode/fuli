import { t } from "@/i18n";
import { taskReason } from "@/features/project-agents/task-reason";
import type { AgentWorkbenchEntry } from "./agent-workbench";

/**
 * One plain sentence for a state that needs explaining: what it waits for
 * and why, or which part of the status is missing. Uses only recorded data;
 * a missing reason is said to be missing, never invented, and a recorded code
 * reads as the sentence it stands for.
 */
export function workbenchStatusDetail(entry: AgentWorkbenchEntry | undefined): string | null {
  if (!entry) return null;
  const reason = taskReason(entry.reason)?.text;
  switch (entry.status) {
    case "blocked":
      return reason ? t("agentRedesign.statusDetail.blocked", { reason }) : t("agentRedesign.statusDetail.blockedUnrecorded");
    case "awaiting_review":
      return reason ? t("agentRedesign.statusDetail.review", { reason }) : t("agentRedesign.statusDetail.reviewUnrecorded");
    case "paused":
      return reason ? t("agentRedesign.statusDetail.paused", { reason }) : t("agentRedesign.statusDetail.pausedUnrecorded");
    case "queued":
      return t("agentRedesign.statusDetail.queued");
    case "awaiting_recruitment":
      return t("agentRedesign.statusDetail.recruitment");
    case "unreported":
      return t(entry.source === "roster" ? "agentRedesign.statusDetail.unreportedRoster" : "agentRedesign.statusDetail.unreportedTasks");
    case "unavailable":
      return t("agentRedesign.statusDetail.unavailable");
    default:
      return null;
  }
}

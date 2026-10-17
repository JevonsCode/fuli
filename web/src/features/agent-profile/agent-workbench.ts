import { normalizeOverviewTasks } from "@/features/overview/overview-data";
import type { ProjectAgentRecord } from "@/types";
import {
  AGENT_WORK_STATUSES,
  type AgentWorkStatus,
  type AgentWorkSummary,
} from "./agent-work-summary";
import type { AgentWorkSummaryState } from "./useAgentWorkSummary";

/**
 * What the workbench may truthfully say about one Agent's current work.
 * `none` is a reported idle state; loading, unreported and unavailable are
 * unknowns and must never be presented or sorted as idle.
 */
export type WorkbenchStatus =
  | AgentWorkStatus
  | "none"
  | "ended"
  | "loading"
  | "unreported"
  | "unavailable";

export interface WorkbenchTaskSnapshot {
  taskId: string;
  title: string;
  updatedAt: string | null;
  participantUpdatedAt: Record<string, string | null>;
  /** The task's recorded result/blocking summary, when there is one. */
  summary: string | null;
}

export interface AgentWorkbenchEntry {
  status: WorkbenchStatus;
  /** roster: complete per-Agent projection; tasks: bounded task page. */
  source: "roster" | "tasks" | "unknown";
  taskId: string | null;
  title: string | null;
  /** Last recorded change of this Agent's task row, never a start time. */
  lastUpdateAt: string | null;
  /** Recorded reason for a waiting state (blocked, review, paused); null if none was recorded. */
  reason: string | null;
  /**
   * Recorded entry into running for the current task. Null when not running,
   * when the provider does not report it, or for rows written before it was
   * recorded; never derived from an update time.
   */
  runningSince: string | null;
}

const RANK: Record<WorkbenchStatus, number> = {
  running: 0,
  awaiting_review: 1,
  blocked: 2,
  paused: 3,
  queued: 4,
  awaiting_recruitment: 5,
  loading: 6,
  unreported: 6,
  unavailable: 6,
  none: 7,
  ended: 8,
};

const WAITING_WITH_REASON: ReadonlySet<WorkbenchStatus> = new Set(["blocked", "awaiting_review", "paused"]);

function isAgentWorkStatus(value: string): value is AgentWorkStatus {
  return (AGENT_WORK_STATUSES as readonly string[]).includes(value);
}

/** Index the bounded task page by id so titles and update times can be shown. */
export function indexWorkbenchTasks(value: unknown, personalSpaceId: string) {
  const index: Record<string, WorkbenchTaskSnapshot> = {};
  for (const task of normalizeOverviewTasks(value, personalSpaceId)) {
    index[task.taskId] = {
      taskId: task.taskId,
      title: task.title,
      updatedAt: task.updatedAt ?? null,
      participantUpdatedAt: Object.fromEntries(
        task.participants.map((item) => [item.agentId, item.updatedAt ?? null]),
      ),
      summary: task.resultSummary?.trim() || null,
    };
  }
  return index;
}

function summaryStatus(
  summary: AgentWorkSummary | undefined,
  state: AgentWorkSummaryState | undefined,
): WorkbenchStatus {
  if (summary) return summary.status;
  if (state === "loading") return "loading";
  if (state === "error") return "unavailable";
  if (state === "incomplete") return "unreported";
  return "none";
}

function rosterStatus(value: string): WorkbenchStatus {
  if (value === "idle") return "none";
  if (value === "ended") return "ended";
  return isAgentWorkStatus(value) ? value : "unreported";
}

export function agentWorkbenchEntry(
  agent: ProjectAgentRecord,
  input: {
    summary?: AgentWorkSummary;
    summaryState?: AgentWorkSummaryState;
    tasks?: Record<string, WorkbenchTaskSnapshot>;
  },
): AgentWorkbenchEntry {
  // The roster projection covers every open task the Agent participates in;
  // the task page is bounded, so it is only a fallback for older providers.
  const fromRoster = typeof agent.workStatus === "string";
  const status = fromRoster
    ? rosterStatus(agent.workStatus as string)
    : summaryStatus(input.summary, input.summaryState);
  const hasTask = isAgentWorkStatus(status);
  const taskId = !hasTask
    ? null
    : fromRoster
      ? agent.currentTaskId ?? null
      : input.summary?.taskId ?? null;
  const snapshot = taskId ? input.tasks?.[taskId] : undefined;
  const title =
    snapshot?.title ??
    (taskId && input.summary?.taskId === taskId ? input.summary.title : null);
  const lastUpdateAt = snapshot
    ? snapshot.participantUpdatedAt[agent.agentId] ?? snapshot.updatedAt
    : null;
  return {
    status,
    source: fromRoster ? "roster" : input.summary ? "tasks" : "unknown",
    taskId,
    title,
    lastUpdateAt,
    reason: WAITING_WITH_REASON.has(status) ? snapshot?.summary ?? null : null,
    runningSince:
      fromRoster && status === "running" ? agent.currentTaskRunningSince ?? null : null,
  };
}

function time(value: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/** Active work first, then the most recent recorded update, then name. */
export function compareWorkbenchRows(
  a: { entry: AgentWorkbenchEntry; name: string },
  b: { entry: AgentWorkbenchEntry; name: string },
) {
  const rank = RANK[a.entry.status] - RANK[b.entry.status];
  if (rank) return rank;
  const left = time(a.entry.lastUpdateAt);
  const right = time(b.entry.lastUpdateAt);
  if (left !== right) {
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  }
  return a.name.localeCompare(b.name);
}

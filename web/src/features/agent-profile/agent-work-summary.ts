import { normalizeOverviewTasks } from "@/features/overview/overview-data";
import { unknownRecord } from "@/features/project-agents/task-evidence";
import type { ProjectAgentTaskRecord } from "@/types";

export const AGENT_WORK_STATUSES = [
  "awaiting_recruitment",
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "blocked",
] as const;

export type AgentWorkStatus = (typeof AGENT_WORK_STATUSES)[number];

export interface AgentWorkSummary {
  status: AgentWorkStatus;
  taskId: string;
  title: string;
}

type Candidate = AgentWorkSummary & { updatedAt?: string | null };

const statusPriority: Record<AgentWorkStatus, number> = {
  blocked: 6,
  awaiting_review: 5,
  running: 4,
  paused: 3,
  queued: 2,
  awaiting_recruitment: 1,
};

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

function isAgentWorkStatus(value: string): value is AgentWorkStatus {
  return (AGENT_WORK_STATUSES as readonly string[]).includes(value);
}

function candidateIsNewer(next: Candidate, current: Candidate) {
  const nextPriority = statusPriority[next.status];
  const currentPriority = statusPriority[current.status];
  if (nextPriority !== currentPriority) return nextPriority > currentPriority;
  const nextTime = next.updatedAt ? Date.parse(next.updatedAt) : Number.NaN;
  const currentTime = current.updatedAt
    ? Date.parse(current.updatedAt)
    : Number.NaN;
  if (!Number.isNaN(nextTime) && !Number.isNaN(currentTime)) {
    return nextTime > currentTime;
  }
  if (!Number.isNaN(nextTime)) return true;
  return false;
}

function candidateFor(task: ProjectAgentTaskRecord, agentId: string) {
  const participant = task.participants.find((item) => item.agentId === agentId);
  // A terminal task cannot be made active by a stale participant heartbeat.
  if (TERMINAL_STATUSES.has(task.status)) return null;
  // A terminal participant has left the task even if the task itself is still
  // open for other agents. Do not fall back to the task status for this agent.
  if (participant && TERMINAL_STATUSES.has(participant.status)) return null;
  const reportedStatus = participant?.status ?? task.status;
  const status = isAgentWorkStatus(reportedStatus)
    ? reportedStatus
    : isAgentWorkStatus(task.status)
      ? task.status
      : null;
  if (!status) return null;
  return {
    status,
    taskId: task.taskId,
    title: task.title,
    updatedAt: task.updatedAt ?? task.createdAt,
  } satisfies Candidate;
}

export function taskAgentIds(task: ProjectAgentTaskRecord) {
  const ids = new Set<string>();
  for (const participant of task.participants) {
    if (participant.agentId) ids.add(participant.agentId);
  }
  for (const id of [task.ownerAgentId, task.leadAgentId, task.coordinatorAgentId]) {
    if (id) ids.add(id);
  }
  return ids;
}

export function taskHasAgent(task: ProjectAgentTaskRecord, agentId: string) {
  return taskAgentIds(task).has(agentId);
}

/** Build one space-scoped work summary without inventing runtime state. */
export function summarizeAgentTasks(value: unknown, personalSpaceId: string) {
  const summaries: Record<string, AgentWorkSummary> = {};
  const candidates: Record<string, Candidate> = {};
  const tasks = normalizeOverviewTasks(value, personalSpaceId);
  for (const task of tasks) {
    for (const agentId of taskAgentIds(task)) {
      const candidate = candidateFor(task, agentId);
      if (!candidate) continue;
      const current = candidates[agentId];
      if (current && !candidateIsNewer(candidate, current)) continue;
      candidates[agentId] = candidate;
      summaries[agentId] = {
        status: candidate.status,
        taskId: candidate.taskId,
        title: candidate.title,
      };
    }
  }
  return summaries;
}

/**
 * A bounded response is complete only when the server proves that all rows
 * were returned or the returned collection is smaller than the requested
 * page. Without that evidence an empty summary must remain unreported.
 */
export function isAgentTaskDataComplete(value: unknown, limit = 200) {
  const record = unknownRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(record.tasks)
      ? record.tasks
      : Array.isArray(record.items)
        ? record.items
        : null;
  if (!rows) return false;

  const hasMore = record.hasMore ?? record.has_more ?? record.truncated;
  if (hasMore === true) return false;
  if (hasMore === false) return true;

  const total = record.total ?? record.totalCount ?? record.total_count;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    return total <= rows.length;
  }
  return rows.length < limit;
}

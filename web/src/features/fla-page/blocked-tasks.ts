import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { taskHasAgent } from '@/features/agent-profile/agent-work-summary'
import { normalizeTask } from '@/features/project-agents/task-evidence'
import type { ProjectAgentTaskBlocker, ProjectAgentTaskRecord } from '@/types'

// The tasks an FLA takes part in that are blocked now, from the same task
// list the console's task pages read (filtered by status on the server).
// Each task is checked by normalizeTask; one it cannot read is left out.
const LIMIT = 50
const listShape = shapeOf(z.array(z.unknown()))

export type BlockedTask = ProjectAgentTaskRecord & { blocker: ProjectAgentTaskBlocker; personalProjectId: string }

export async function readBlockedTasks(personalSpaceId: string, agentId: string, signal?: AbortSignal): Promise<BlockedTask[]> {
  const params = new URLSearchParams({ personalSpaceId, agentId, status: 'blocked', limit: String(LIMIT) })
  const rows = await getJson(`/api/project-agent-tasks?${params}`, listShape, { signal })
  return rows.map(normalizeTask).filter((task): task is BlockedTask => Boolean(task && task.status === 'blocked'
    && task.blocker && task.personalProjectId && taskHasAgent(task, agentId)))
}

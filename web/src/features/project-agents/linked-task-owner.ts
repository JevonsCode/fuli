import { getJson } from '@/api/client'
import type { ProjectAgentTaskRecord } from '@/types'
import { normalizeTask } from './task-evidence'

interface LinkedTask {
  personalSpaceId: string
  taskId: string
  /** The link's ?project=, when it names one. */
  personalProjectId?: string
  /** The space's own Agent for an id (current or earlier), if there is one. */
  spaceAgentId: (agentId: string) => string | undefined
}

// Who the task is for first, then whoever else takes part.
function ownerCandidates(task: ProjectAgentTaskRecord) {
  return [
    task.ownerAgentId, task.leadAgentId, task.coordinatorAgentId,
    ...task.participants.filter(({ role }) => role === 'lead').map(({ agentId }) => agentId),
    ...task.participants.map(({ agentId }) => agentId),
  ].filter((id): id is string => Boolean(id))
}

/**
 * The Agent whose page shows the task an older link names without an Agent
 * (?task=). The exact task is read whatever its status, so a completed,
 * failed or cancelled task, which is not in anyone's open work, still opens.
 * The task must belong to the space (and to the link's project, when named),
 * and the Agent must be one of the space's own; otherwise there is none ('').
 */
export async function linkedTaskOwner({ personalSpaceId, taskId, personalProjectId, spaceAgentId }: LinkedTask) {
  const query = new URLSearchParams({ personalSpaceId })
  if (personalProjectId) query.set('personalProjectId', personalProjectId)
  let task: ProjectAgentTaskRecord | null
  try {
    task = normalizeTask(await getJson<unknown>(`/api/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`))
  } catch {
    return ''
  }
  if (!task || task.taskId !== taskId) return ''
  if (task.personalSpaceId && task.personalSpaceId !== personalSpaceId) return ''
  if (personalProjectId && task.personalProjectId && task.personalProjectId !== personalProjectId) return ''
  for (const candidate of ownerCandidates(task)) {
    const agentId = spaceAgentId(candidate)
    if (agentId) return agentId
  }
  return ''
}

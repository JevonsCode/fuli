import type { RouteLocationRaw } from 'vue-router'
import { getJson } from '@/api/client'
import { isBoardTask } from '@/features/agent-workbench/agent-task-board'
import { openWorkflows, readAgentWorkflows } from '@/features/agent-workbench/agent-workflows'
import { employeeTemplateIdForAgent } from '@/features/employees/catalog'
import { arrayOf, normalizeTask, unknownRecord } from '@/features/project-agents/task-evidence'
import type { ProjectAgentRecord, ProjectAgentTaskRecord } from '@/types'
import { taskHasAgent } from './agent-work-summary'
import { agentProfilePath } from './profile-model'

/** Where a pinned Agent's own work lives, if anywhere: what its right-click menu offers. */
export interface AgentWorkSurfaces {
  workbench: RouteLocationRaw | null
  workflow: RouteLocationRaw | null
}

/**
 * A built-in role's workbench is its own page. Any other Agent's workbench is
 * the first tab of its profile, present on the same rule the profile uses:
 * board tasks or open workflows. Workflows sit inside that tab, so the
 * workflow entry opens the tab at the workflow list.
 */
export async function readAgentWorkSurfaces(spaceId: string, agent: ProjectAgentRecord): Promise<AgentWorkSurfaces> {
  const templateId = employeeTemplateIdForAgent(agent)
  if (templateId) return { workbench: `/employees/${encodeURIComponent(templateId)}`, workflow: null }
  const params = new URLSearchParams({ personalSpaceId: spaceId, agentId: agent.agentId })
  const [taskResult, workflowResult] = await Promise.allSettled([
    getJson<unknown>(`/api/project-agent-tasks?${params}&limit=200`),
    readAgentWorkflows(spaceId, agent.agentId),
  ])
  if (taskResult.status === 'rejected' && workflowResult.status === 'rejected') throw taskResult.reason
  const tasks = taskResult.status === 'fulfilled' ? agentTasks(taskResult.value, spaceId, agent.agentId) : []
  const workflows = workflowResult.status === 'fulfilled' ? openWorkflows(workflowResult.value) : []
  const profile = agentProfilePath(spaceId, agent.agentId)
  const hasWorkbench = tasks.some(isBoardTask) || workflows.length > 0
  return {
    workbench: hasWorkbench ? { path: profile, query: { tab: 'workbench' } } : null,
    workflow: workflows.length ? { path: profile, query: { tab: 'workbench' }, hash: '#agent-workflows-heading' } : null,
  }
}

function agentTasks(value: unknown, spaceId: string, agentId: string) {
  const record = unknownRecord(value)
  return arrayOf(Array.isArray(value) ? value : (record.tasks ?? record.items))
    .map(normalizeTask)
    .filter((task): task is ProjectAgentTaskRecord => Boolean(task
      && (!task.personalSpaceId || task.personalSpaceId === spaceId)
      && taskHasAgent(task, agentId)))
}

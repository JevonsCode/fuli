import type { RouteLocationRaw } from 'vue-router'
import { openWorkflows, readAgentWorkflows } from '@/features/agent-workbench/agent-workflows'
import { employeeTemplateIdForAgent } from '@/features/employees/catalog'
import type { ProjectAgentRecord } from '@/types'
import { agentProfilePath } from './profile-model'

/** Where a pinned Agent's own work lives, if anywhere: what its right-click menu offers. */
export interface AgentWorkSurfaces {
  workbench: RouteLocationRaw | null
  workflow: RouteLocationRaw | null
}

/**
 * A built-in role's workbench is the first tab of its page; no other FLA has
 * one (Jevons 11-04: the board is Jefa's own). Any FLA's workflows are a tab.
 */
export async function readAgentWorkSurfaces(spaceId: string, agent: ProjectAgentRecord): Promise<AgentWorkSurfaces> {
  const profile = agentProfilePath(spaceId, agent.agentId)
  if (employeeTemplateIdForAgent(agent)) return { workbench: { path: profile, query: { tab: 'workbench' } }, workflow: null }
  const workflows = openWorkflows(await readAgentWorkflows(spaceId, agent.agentId))
  return { workbench: null, workflow: workflows.length ? { path: profile, query: { tab: 'workflows' } } : null }
}

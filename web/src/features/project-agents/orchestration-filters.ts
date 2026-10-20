import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { ProjectAgentRecord, ProjectAgentStatus } from '@/types'
import { assignmentsFor } from './agent-roster-records'

// 编排: the collection's filters live in the URL so Back from an Agent's page,
// a refresh or a shared link returns to the same view.
//   ?project=<id> (repeated)  the chosen projects; absent means every project
//                             (and Agents without one), an empty value means none
//   ?status=active|inactive|archived
//   ?q=<text>
export const ORCHESTRATION_STATUSES = ['all', 'active', 'inactive', 'archived'] as const
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number]

export interface OrchestrationFilters {
  /** null is the unrestricted view, including Agents not assigned to a project yet. */
  projects: string[] | null
  status: OrchestrationStatus
  search: string
}

const FILTER_KEYS = ['project', 'status', 'q'] as const

function strings(value: LocationQuery[string] | undefined) {
  const values = Array.isArray(value) ? value : [value]
  return values.filter((item): item is string => typeof item === 'string')
}

export function readOrchestrationFilters(query: LocationQuery): OrchestrationFilters {
  const projects = 'project' in query ? [...new Set(strings(query.project).filter(Boolean))] : null
  const status = strings(query.status)[0] ?? ''
  return {
    projects,
    status: (ORCHESTRATION_STATUSES as readonly string[]).includes(status) ? status as OrchestrationStatus : 'all',
    search: strings(query.q)[0] ?? '',
  }
}

/** Write filters into the URL, keeping every unrelated query key. */
export function orchestrationFilterQuery(query: LocationQuery, filters: OrchestrationFilters): LocationQueryRaw {
  const next: LocationQueryRaw = Object.fromEntries(
    Object.entries(query).filter(([key]) => !(FILTER_KEYS as readonly string[]).includes(key)),
  )
  if (filters.projects) next.project = filters.projects.length ? [...filters.projects] : ''
  if (filters.status !== 'all') next.status = filters.status
  if (filters.search) next.q = filters.search
  return next
}

/** Everything a reader may search an Agent by. */
export function agentSearchText(agent: ProjectAgentRecord) {
  return [
    agent.agentId, agent.profile.name, agent.profile.displayName ?? '', agent.profile.occupationEmoji ?? '', agent.profile.responsibility,
    ...(agent.profile.capabilities ?? []), ...(agent.profile.workKinds ?? []),
    ...assignmentsFor(agent).flatMap((item) => [item.personalProjectId, item.responsibility, item.scope ?? '', ...(item.workKinds ?? [])]),
    ...(agent.tasks ?? []).flatMap((task) => [task.taskId, task.title, task.workKind ?? '']),
  ].join(' ')
}

const STATUS_ORDER: Record<ProjectAgentStatus, number> = { active: 0, inactive: 1, archived: 2 }

/** Available first, then by name, then by id, so the order never depends on the read. */
export function compareOrchestrationAgents(left: ProjectAgentRecord, right: ProjectAgentRecord, locale: string) {
  return STATUS_ORDER[left.profile.status] - STATUS_ORDER[right.profile.status]
    || left.profile.name.localeCompare(right.profile.name, locale)
    || left.agentId.localeCompare(right.agentId, locale)
}

/** Same-named projects (session fallbacks) show once with a count instead of repeating the name. */
export function projectChipGroups(projects: Array<{ name: string }>) {
  const groups = new Map<string, number>()
  for (const project of projects) groups.set(project.name, (groups.get(project.name) ?? 0) + 1)
  return [...groups].map(([name, count]) => ({ name, count }))
}

/** One Agent's management page under 编排. */
export function agentManagementPath(spaceId: string, agentId: string) {
  return `/project-agents/manage/${encodeURIComponent(spaceId)}/${encodeURIComponent(agentId)}`
}

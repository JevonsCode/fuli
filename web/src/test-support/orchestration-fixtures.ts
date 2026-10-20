import type { ProjectAgentRecord } from '@/types'

// Synthetic 编排 data shared by the collection and Agent page specs: one Agent
// reported as two project rows (the roster merges them), two projects.
export const orchestrationAgents: ProjectAgentRecord[] = [
  {
    agentId: 'shared-agent',
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-a',
    profile: {
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      capabilities: ['活动策划', '活动复盘'],
      initialPreferences: ['先给结论'],
      status: 'active',
      agentType: 'durable',
      defaultModelStrategy: {
        mode: 'adaptive',
        capabilityHints: ['活动复盘'],
      },
      executorPolicy: { mode: 'flexible', allowList: [] },
    },
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T01:00:00Z',
    assignments: [{
      assignmentId: 'assignment-a',
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      agentId: 'shared-agent',
      responsibility: '负责活动方案与复盘。',
      scope: '活动项目',
      status: 'active',
      assignedAt: '2026-08-17T00:00:00Z',
      updatedAt: '2026-08-17T01:00:00Z',
    }],
  },
  {
    agentId: 'shared-agent',
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-b',
    profile: {
      name: '设计 Agent',
      responsibility: '负责界面结构与可用性审查。',
      capabilities: ['界面设计'],
      initialPreferences: [],
      status: 'inactive',
    },
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T02:00:00Z',
    assignments: [{
      assignmentId: 'assignment-b',
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-b',
      agentId: 'shared-agent',
      responsibility: '负责界面结构与可用性审查。',
      scope: '设计项目',
      status: 'active',
      assignedAt: '2026-08-17T00:00:00Z',
      updatedAt: '2026-08-17T02:00:00Z',
    }],
  },
]

export function orchestrationState() {
  return {
    mode: 'personal_only' as const,
    activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: '我' }],
    personalProjects: [
      { project_id: 'project-a', personal_space_id: 'personal-1', profile: { name: '活动项目', sources: [], boundaries: [] } },
      { project_id: 'project-b', personal_space_id: 'personal-1', profile: { name: '设计项目', sources: [], boundaries: [] } },
    ],
    projects: [],
    subscriptions: [],
  }
}

/** Every read the page makes, answered with empty but reported collections. */
export function orchestrationResponse(url: string): Promise<unknown> {
  const agents = orchestrationAgents
  if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
  if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: agents.flatMap((agent) => agent.assignments ?? []) })
  if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
  if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
  if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
  if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
  if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
  if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
  if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
  return Promise.resolve([])
}

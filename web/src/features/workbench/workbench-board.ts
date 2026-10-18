import type { AgentAttention } from '@/features/project-agents/attention-store'
import type { ProjectAgentTaskRecord } from '@/types'
import type { RouteLocationRaw } from 'vue-router'

// What the workbench page hands every design: the same data and the same
// links, so a design only decides how the work is shown.
export interface AgentFace { name: string; image: string | null; color: string | null; softColor: string | null }

export interface WorkbenchBoard {
  /** The active personal space, for designs that read extra space data. */
  personalSpaceId?: string
  tasks: readonly ProjectAgentTaskRecord[]
  attention: readonly AgentAttention[]
  projectName: (projectId?: string | null) => string
  agentFace: (agentId?: string | null) => AgentFace
  taskHref: (task: ProjectAgentTaskRecord) => RouteLocationRaw
  questionHref: (item: AgentAttention) => RouteLocationRaw
  statusLabel: (status: string) => string
  since: (value?: string | null) => string
}

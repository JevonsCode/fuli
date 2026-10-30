import { getJson, postJson } from '@/api/client'

// An Agent's own workflows (rec#60 D-78), as GET /api/agent-workflows serves
// them, and the person's decision on the version the page showed.

export interface AgentWorkflowStep { title: string; detail?: string }

export interface AgentWorkflowVersion {
  workflowId: string
  version: number
  name: string
  purpose: string
  steps: AgentWorkflowStep[]
  /** `candidate:<id>` (a learned repeated pattern), `agent` or `person`. */
  source: string
  createdBy: 'agent' | 'person'
  createdAt: string
}

export interface AgentWorkflowRun {
  runId: string
  version: number
  taskId: string | null
  outcome: 'done' | 'stopped' | 'failed'
  note: string | null
  recordedAt: string
}

export interface AgentWorkflow {
  workflowId: string
  status: 'proposed' | 'active' | 'retired'
  personalProjectId: string | null
  versionCount: number
  /** The confirmed version an Agent reads; null until the person confirms one. */
  active: AgentWorkflowVersion | null
  /** The version waiting for the person, if any. */
  pending: AgentWorkflowVersion | null
  recentRuns: AgentWorkflowRun[]
  createdAt: string
  updatedAt: string
}

export type AgentWorkflowDecision = 'confirm' | 'reject' | 'retire'

export async function readAgentWorkflows(personalSpaceId: string, agentId: string) {
  const query = new URLSearchParams({ personalSpaceId, agentId })
  return (await getJson<{ workflows: AgentWorkflow[] }>(`/api/agent-workflows?${query}`)).workflows
}

export function decideAgentWorkflow(workflowId: string, decision: AgentWorkflowDecision, version: number) {
  return postJson(`/api/agent-workflows/${encodeURIComponent(workflowId)}/decision`, { decision, version })
}

/** What the workbench shows: proposed and active workflows, those waiting for the person first. */
export function openWorkflows(workflows: readonly AgentWorkflow[]) {
  return workflows.filter((workflow) => workflow.status !== 'retired')
    .sort((a, b) => Number(Boolean(b.pending)) - Number(Boolean(a.pending)) || b.updatedAt.localeCompare(a.updatedAt))
}

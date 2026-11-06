import { t } from '@/i18n'
import type { AgentWorkflow } from './agent-workflows'

/** The version a workflow's card shows: the proposal waiting on the person, else the active one. */
export function workflowShown(workflow: AgentWorkflow) {
  return (workflow.pending ?? workflow.active)!
}

export function workflowState(workflow: AgentWorkflow) {
  if (!workflow.pending) return t('agentWorkbench.workflows.active')
  return t(workflow.active ? 'agentWorkbench.workflows.changeAwaiting' : 'agentWorkbench.workflows.awaiting')
}

/** Past this many workflows the index offers a search. */
export const WORKFLOW_SEARCH_FROM = 7

export function matchesWorkflow(workflow: AgentWorkflow, query: string) {
  const { name, purpose } = workflowShown(workflow)
  const wanted = query.trim().toLocaleLowerCase()
  return !wanted || `${name} ${purpose}`.toLocaleLowerCase().includes(wanted)
}

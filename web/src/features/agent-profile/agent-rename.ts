import { apiErrorReason, putJson } from '@/api/client'
import type { ProjectAgentRecord } from '@/types'
import { projectAgentShape } from './agent-record-shape'
import { rememberRoleName } from './role-names'

// Renaming an Agent (rec#11 D-89): only the shown name changes; the Agent ID,
// and a built-in role's own name for `#FLA`, stay. `null` gives a built-in
// role its own name back. The longest name a person can give.
export const MAX_AGENT_NAME = 64

export async function renameAgent(agent: Pick<ProjectAgentRecord, 'personalSpaceId' | 'agentId'>, displayName: string | null) {
  const record = await putJson(`/api/project-agents/${encodeURIComponent(agent.agentId)}/name`, {
    personalSpaceId: agent.personalSpaceId,
    displayName,
  }, projectAgentShape)
  // A renamed built-in role reads by its new name in every label at once.
  rememberRoleName(record)
  return record
}

/** The free names offered when another Agent already uses this one, else null. */
export function freeNamesOffered(error: unknown): string[] | null {
  const reason = apiErrorReason(error, '')
  if (!reason.startsWith('agent_name_taken')) return null
  const listed = reason.match(/free names:\s*([^.]*)\./)?.[1] ?? ''
  return listed.split(',').map(name => name.trim()).filter(Boolean)
}

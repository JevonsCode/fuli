import { ApiError, apiErrorCode, putJson } from '@/api/client'
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

/** Why a rename was refused because another Agent already has the name: who
 * (and the projects each works in) and free names, as the console API sends
 * them; null for any other failure. */
export function nameTaken(error: unknown): { usedBy: { name: string; projects: string[] }[]; freeNames: string[] } | null {
  if (apiErrorCode(error) !== 'agent_name_taken' || !(error instanceof ApiError)) return null
  try {
    const body = JSON.parse(error.detail) as { usedBy?: unknown; freeNames?: unknown }
    const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    const usedBy = Array.isArray(body.usedBy) ? body.usedBy.filter(item => typeof item?.name === 'string')
      .map(item => ({ name: item.name as string, projects: strings(item.projects) })) : []
    return { usedBy, freeNames: strings(body.freeNames) }
  } catch {
    return null
  }
}

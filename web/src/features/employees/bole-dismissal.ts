import { z } from 'zod'
import { ApiError, apiErrorReason, getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { builtInRole } from '@/features/agent-profile/role-names'
import { t } from '@/i18n'

// The limits of the dismiss_project_agent tool. The form only saves a round
// trip: the host and the Provider refuse the same things, and only they know
// the placeholder words and credentials a reason may not be.
const MIN_TEXT = 4
const MAX_TEXT = 1000
const MAX_LESSONS = 3

export const dismissalReceiptShape = shapeOf(z.looseObject({ agentId: z.string(), name: z.string() }))
const coordinationLeadShape = shapeOf(z.looseObject({ teamLeadAgentId: z.string().nullish() }))

/** A reason or lesson the tool's length limits allow. */
export function textFits(value: string) {
  const length = [...value.trim()].length
  return length >= MIN_TEXT && length <= MAX_TEXT
}

/** One lesson per line; blank lines say nothing. */
export const lessonLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean)

export const lessonsFit = (lessons: string[]) => lessons.length <= MAX_LESSONS && lessons.every(textFits)

/** Why this Agent cannot be dismissed now, as far as the console can see; null when nothing stands in the way. */
export function dismissalBlock(agent: { id: string; hasOpenTask: boolean; leadsProject: boolean }): 'built_in' | 'open_tasks' | 'project_lead' | null {
  if (builtInRole(agent.id)) return 'built_in'
  if (agent.hasOpenTask) return 'open_tasks'
  return agent.leadsProject ? 'project_lead' : null
}

/** Who leads these projects. A failed read names nobody: the Provider still refuses a lead. */
export async function readProjectLeads(space: string, projectIds: string[]) {
  const results = await Promise.allSettled(projectIds.map(personalProjectId => getJson(
    `/api/project-agent-coordination-policy?${new URLSearchParams({ personalSpaceId: space, personalProjectId })}`,
    coordinationLeadShape,
  )))
  return new Set(results.flatMap(result => result.status === 'fulfilled' && result.value.teamLeadAgentId ? [result.value.teamLeadAgentId] : []))
}

/** Why the dismissal was refused, in the person's language. */
export function dismissalRefusal(error: unknown) {
  if (error instanceof ApiError && (error.status === 400 || error.status === 422)) return t('employees.bole.dismissal.textRefused')
  if (error instanceof ApiError && error.status === 409) return t('employees.bole.dismissal.stateRefused')
  return apiErrorReason(error)
}

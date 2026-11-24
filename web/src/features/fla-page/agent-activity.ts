import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { normalizeActivity } from '@/features/project-agents/activity-evidence'
import type { ProjectAgentActivityResult } from '@/types'

// 最近的活动 on an FLA's page: the tasks it finished, failed or cancelled each
// day over the past year (GET /api/project-agent-activity). FlaActivity.vue
// reads it only once the section comes into view.
const daySchema = z.looseObject({ date: z.string(), total: z.number(), tasks: z.array(z.unknown()).nullish() })
const activityShape = shapeOf(z.looseObject({ days: z.array(daySchema) }))

/** The past year up to today, as the Provider's UTC dates. */
export function activityRange(now = new Date()) {
  const from = new Date(now)
  from.setUTCFullYear(from.getUTCFullYear() - 1)
  return { fromDate: from.toISOString().slice(0, 10), toDate: now.toISOString().slice(0, 10) }
}

/** One FLA's activity over the past year, each day of the range filled in (an empty list when none ended). */
export async function readAgentActivity(personalSpaceId: string, agentId: string, signal?: AbortSignal): Promise<ProjectAgentActivityResult> {
  const query = new URLSearchParams({ personalSpaceId, agentId, ...activityRange() })
  const value = await getJson(`/api/project-agent-activity?${query}`, activityShape, { signal })
  return normalizeActivity(value, { agentId, personalSpaceId }) ?? { agentId, personalSpaceId, days: [] }
}

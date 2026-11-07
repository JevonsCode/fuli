import type { LocationQuery, RouteLocationRaw } from 'vue-router'

import { MODEL_ROLES, type ModelRoleId } from './model'

// A link into one use's 「查看详情」 on 模型与用量 (Jevons 11-07): /models?details=<role>
// opens that use's details, and #<part> marks the part of them the link is about.
const DETAILS_PARTS = ['delegation'] as const
export type ModelDetailsPart = typeof DETAILS_PARTS[number]

export const modelDetailsLink = (role: ModelRoleId, part?: ModelDetailsPart): RouteLocationRaw =>
  ({ path: '/models', query: { details: role }, ...(part ? { hash: `#${part}` } : {}) })

/** The use and part a link names, or null when it names none this page has. */
export function linkedModelDetails(query: LocationQuery, hash: string): { role: ModelRoleId; part: ModelDetailsPart | null } | null {
  const role = MODEL_ROLES.find(candidate => candidate === query.details)
  if (!role) return null
  return { role, part: DETAILS_PARTS.find(candidate => `#${candidate}` === hash) ?? null }
}

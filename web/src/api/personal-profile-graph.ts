import { z } from 'zod'

import { getJson } from './client'
import { shapeFor } from './response-shape'
import { appendKnowledgeGraphPage } from '@/features/knowledge/model'
import type { KnowledgeGraph } from '@/types'

// The fields the 偏好 page relies on beyond the items themselves: the case a
// preference states (stated_case, read-only) and its qualifiers, which count
// the habits that state none (features/preferences/habit-conditions.ts).
const preferenceItem = z.looseObject({ id: z.string(), stated_case: z.string().optional(),
  preference_qualifiers: z.record(z.string(), z.unknown()).optional() })
export const graphPageShape = shapeFor<KnowledgeGraph>(z.looseObject({ nodes: z.array(preferenceItem), edges: z.array(preferenceItem) }))

// Profile counts and confirmation actions must see the same complete history.
export async function readPersonalProfileGraph(spaceId: string, signal?: AbortSignal): Promise<KnowledgeGraph> {
  // Omitting offset requests the legacy truncated preview, which has no cursor.
  const query = new URLSearchParams({ spaceId, limit: '500', offset: '0' })
  let graph: KnowledgeGraph | null = null
  const visited = new Set<number>([0])
  for (let page = 0; page < 20; page++) {
    const result = await getJson(`/api/graph?${query}`, graphPageShape, { signal })
    graph = appendKnowledgeGraphPage(graph, result)
    if (!result.truncated) return graph
    const offset = result.next_offset
    if (!Number.isInteger(offset) || offset == null || offset <= Number(query.get('offset')) || visited.has(offset)) break
    visited.add(offset)
    query.set('offset', String(offset))
  }
  throw new Error('Personal profile history is incomplete. Reload before reviewing preferences.')
}

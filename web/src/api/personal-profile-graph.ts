import { getJson } from './client'
import { appendKnowledgeGraphPage } from '@/features/knowledge/model'
import type { KnowledgeGraph } from '@/types'

// Profile counts and confirmation actions must see the same complete history.
export async function readPersonalProfileGraph(spaceId: string, signal?: AbortSignal): Promise<KnowledgeGraph> {
  // Omitting offset requests the legacy truncated preview, which has no cursor.
  const query = new URLSearchParams({ spaceId, limit: '500', offset: '0' })
  let graph: KnowledgeGraph | null = null
  const visited = new Set<number>([0])
  for (let page = 0; page < 20; page++) {
    const result = await getJson<KnowledgeGraph>(`/api/graph?${query}`, { signal })
    if (!Array.isArray(result?.nodes) || !Array.isArray(result?.edges)) throw new Error('Invalid personal profile history')
    graph = appendKnowledgeGraphPage(graph, result)
    if (!result.truncated) return graph
    const offset = result.next_offset
    if (!Number.isInteger(offset) || offset == null || offset < 0 || visited.has(offset)) break
    visited.add(offset)
    query.set('offset', String(offset))
  }
  throw new Error('Personal profile history is incomplete. Reload before reviewing preferences.')
}

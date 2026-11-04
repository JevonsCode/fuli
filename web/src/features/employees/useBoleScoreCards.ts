import { ref } from 'vue'
import { getJson } from '@/api/client'
import { scoreCardShape, type ScoreCard } from './bole-performance'

export type ScoreCardRead = { status: 'ready'; card: ScoreCard } | { status: 'failed' }

/**
 * The score card of each person on Bole's team list, read one per Agent after
 * the list itself. A missing entry is still being read, and a failed read says
 * so: neither is ever shown as a result. A newer list drops any read still on
 * its way.
 */
export function useBoleScoreCards() {
  const reads = ref<Record<string, ScoreCardRead>>({})
  const reading = ref(false)
  let generation = 0

  async function read(space: string, agentId: string, current: number) {
    const query = new URLSearchParams({ personalSpaceId: space })
    let result: ScoreCardRead
    try {
      const card = await getJson(`/api/project-agents/${encodeURIComponent(agentId)}/score-card?${query}`, scoreCardShape)
      result = { status: 'ready', card }
    } catch {
      result = { status: 'failed' }
    }
    if (current === generation) reads.value = { ...reads.value, [agentId]: result }
  }

  async function readAll(space: string, agentIds: string[]) {
    const current = ++generation
    reads.value = {}
    reading.value = agentIds.length > 0
    await Promise.all(agentIds.map(agentId => read(space, agentId, current)))
    if (current === generation) reading.value = false
  }

  /** Reads one person's card again, after a failed read. */
  async function retry(space: string, agentId: string) {
    reads.value = Object.fromEntries(Object.entries(reads.value).filter(([id]) => id !== agentId))
    await read(space, agentId, generation)
  }

  return { reads, reading, readAll, retry }
}

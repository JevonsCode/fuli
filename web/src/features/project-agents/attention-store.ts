import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getJson, postJson } from '@/api/client'

export interface AgentAttention {
  requestId: string; personalSpaceId: string; personalProjectId: string; agentId: string
  taskId: string | null; kind: string; title: string; detail: string; requestedAction: string
  revision: number; status: 'open' | 'resolved' | 'cancelled'; createdAt: string
}
interface AttentionList { items: AgentAttention[]; total: number; counts: Record<string, number> }

export const useAgentAttention = defineStore('agent-attention', () => {
  const spaceId = ref('')
  const counts = ref<Record<string, number>>({})
  const total = ref(0)
  const items = ref<AgentAttention[]>([])
  const filteredTotal = ref(0)
  const agentId = ref('')
  const open = ref(false)
  const loading = ref(false)
  const error = ref('')
  let version = 0

  async function refresh() {
    const current = ++version
    if (!spaceId.value) return
    loading.value = true
    try {
      const scope = new URLSearchParams({ personalSpaceId: spaceId.value, status: 'open' })
      const summary = await getJson<AttentionList>(`/api/agent-attention?${scope}&limit=1`)
      if (current !== version) return
      counts.value = summary.counts; total.value = summary.total
      if (open.value) {
        if (agentId.value) scope.set('agentId', agentId.value)
        const result = await getJson<AttentionList>(`/api/agent-attention?${scope}&limit=100`)
        if (current !== version) return
        items.value = result.items; filteredTotal.value = result.total
      }
      error.value = ''
    } catch (cause) {
      if (current === version) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally { if (current === version) loading.value = false }
  }
  function setSpace(id: string) {
    if (spaceId.value === id) return
    version++; spaceId.value = id; counts.value = {}; items.value = []; total.value = 0
    filteredTotal.value = 0; error.value = ''; open.value = false; loading.value = false
    if (id) void refresh()
  }
  function show(id = '') {
    agentId.value = id; items.value = []; filteredTotal.value = 0; open.value = true
    void refresh()
  }
  async function more() {
    if (loading.value) return
    const current = ++version
    loading.value = true
    try {
      const query = new URLSearchParams({ personalSpaceId: spaceId.value, status: 'open', limit: '100', offset: String(items.value.length) })
      if (agentId.value) query.set('agentId', agentId.value)
      const result = await getJson<AttentionList>(`/api/agent-attention?${query}`)
      if (current !== version) return
      const seen = new Set(items.value.map(item => item.requestId))
      items.value.push(...result.items.filter(item => !seen.has(item.requestId))); filteredTotal.value = result.total
    } catch (cause) { if (current === version) error.value = String(cause) }
    finally { if (current === version) loading.value = false }
  }
  async function respond(item: AgentAttention, response: string) {
    const originalSpace = spaceId.value
    await postJson('/api/agent-attention/respond', {
      personalSpaceId: originalSpace, personalProjectId: item.personalProjectId,
      requestId: item.requestId, expectedRevision: item.revision, response,
    })
    if (spaceId.value === originalSpace) await refresh()
  }
  return { spaceId, counts, total, items, filteredTotal, agentId, open, loading, error, setSpace, show, refresh, more, respond }
})

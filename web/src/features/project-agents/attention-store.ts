import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getJson, postJson } from '@/api/client'
import { t } from '@/i18n'

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
  const previewItems = ref<AgentAttention[]>([])
  const previewTotal = ref(0)
  const previewSpaceId = ref('')
  const previewLoading = ref(false)
  const previewLoaded = ref(false)
  const previewError = ref('')
  const agentId = ref('')
  const open = ref(false)
  const loading = ref(false)
  const error = ref('')
  let version = 0
  let previewVersion = 0

  function applyPreview(id: string, result: AttentionList) {
    previewSpaceId.value = id
    previewItems.value = result.items
      .filter(item => item.personalSpaceId === id)
      .slice(0, 5)
    previewTotal.value = result.total
    previewLoaded.value = true
    previewError.value = ''
  }

  function resetPreview() {
    previewVersion++
    previewSpaceId.value = ''
    previewItems.value = []
    previewTotal.value = 0
    previewLoaded.value = false
    previewLoading.value = false
    previewError.value = ''
  }

  async function refresh() {
    const current = ++version
    if (!spaceId.value) return
    loading.value = true
    const currentPreview = ++previewVersion
    previewSpaceId.value = spaceId.value
    previewLoading.value = true
    previewError.value = ''
    try {
      const scope = new URLSearchParams({ personalSpaceId: spaceId.value, status: 'open' })
      const summary = await getJson<AttentionList>(`/api/agent-attention?${scope}&limit=5`)
      if (current !== version) return
      counts.value = summary.counts; total.value = summary.total
      if (currentPreview === previewVersion) {
        applyPreview(spaceId.value, summary)
        previewLoading.value = false
      }
      if (open.value) {
        if (agentId.value) scope.set('agentId', agentId.value)
        const result = await getJson<AttentionList>(`/api/agent-attention?${scope}&limit=100`)
        if (current !== version) return
        items.value = result.items.filter(item => item.personalSpaceId === spaceId.value && (!agentId.value || item.agentId === agentId.value)); filteredTotal.value = result.total
      }
      error.value = ''
    } catch (cause) {
      if (current === version) error.value = cause instanceof Error ? cause.message : String(cause)
      if (currentPreview === previewVersion) {
        previewError.value = cause instanceof Error ? cause.message : String(cause)
        previewLoading.value = false
      }
    } finally {
      if (current === version) loading.value = false
      if (currentPreview === previewVersion) previewLoading.value = false
    }
  }

  async function refreshPreview(id = spaceId.value, options: { force?: boolean } = {}) {
    if (!id) return
    if (!options.force && previewSpaceId.value === id && (previewLoading.value || previewLoaded.value)) return
    const current = ++previewVersion
    if (previewSpaceId.value !== id) {
      previewItems.value = []
      previewTotal.value = 0
      previewLoaded.value = false
    }
    previewSpaceId.value = id
    previewLoading.value = true
    previewError.value = ''
    try {
      const scope = new URLSearchParams({ personalSpaceId: id, status: 'open', limit: '5' })
      const result = await getJson<AttentionList>(`/api/agent-attention?${scope}`)
      if (current !== previewVersion) return
      applyPreview(id, result)
    } catch (cause) {
      if (current === previewVersion) previewError.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (current === previewVersion) previewLoading.value = false
    }
  }
  function setSpace(id: string) {
    if (spaceId.value === id) return
    version++; spaceId.value = id; counts.value = {}; items.value = []; total.value = 0
    filteredTotal.value = 0; error.value = ''; open.value = false; loading.value = false
    agentId.value = ''
    resetPreview()
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
      items.value.push(...result.items.filter(item => item.personalSpaceId === spaceId.value && (!agentId.value || item.agentId === agentId.value) && !seen.has(item.requestId))); filteredTotal.value = result.total
    } catch (cause) { if (current === version) error.value = String(cause) }
    finally { if (current === version) loading.value = false }
  }
  async function respond(item: AgentAttention, response: string) {
    const originalSpace = spaceId.value
    if (!originalSpace || item.personalSpaceId !== originalSpace) throw new Error(t('attention.wrongSpace'))
    await postJson('/api/agent-attention/respond', {
      personalSpaceId: originalSpace, personalProjectId: item.personalProjectId,
      requestId: item.requestId, expectedRevision: item.revision, response,
    })
    if (spaceId.value === originalSpace) {
      // The POST has confirmed this reply. A failed refresh must not offer it again.
      items.value = items.value.filter(candidate => candidate.requestId !== item.requestId)
      total.value = Math.max(0, total.value - 1)
      counts.value = { ...counts.value, [item.agentId]: Math.max(0, (counts.value[item.agentId] ?? 0) - 1) }
      if (!agentId.value || agentId.value === item.agentId) filteredTotal.value = Math.max(0, filteredTotal.value - 1)
      if (previewSpaceId.value === originalSpace) {
        previewItems.value = previewItems.value.filter(candidate => candidate.requestId !== item.requestId)
        previewTotal.value = Math.max(0, previewTotal.value - 1)
      }
      await refresh()
    }
  }
  return {
    spaceId, counts, total, items, filteredTotal, previewItems, previewTotal, previewSpaceId,
    previewLoading, previewLoaded, previewError, agentId, open, loading, error,
    setSpace, show, refresh, refreshPreview, more, respond,
  }
})

export function attentionTaskHref(item: AgentAttention) {
  const query = new URLSearchParams({ agent: item.agentId, project: item.personalProjectId })
  if (item.taskId) query.set('task', item.taskId)
  return `/project-agents?${query}${item.taskId ? `#task-${encodeURIComponent(item.taskId)}` : ''}`
}

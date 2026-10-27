import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, getJson, postJson } from '@/api/client'
import { t } from '@/i18n'
import type { AttentionAnswer, AttentionDelivery, AttentionReplyDraft } from './attention-replies'
import type { ProjectAgentTaskBlocker } from '@/types'

export interface AgentAttention {
  requestId: string; personalSpaceId: string; personalProjectId: string; agentId: string
  taskId: string | null; kind: string; title: string; detail: string; requestedAction: string; options?: string[] | null
  revision: number; status: 'open' | 'resolved' | 'cancelled'; createdAt: string
  /** The linked task's current block, read with the request; absent once the task left blocked. */
  taskBlocker?: ProjectAgentTaskBlocker | null
}
interface AttentionList { items: AgentAttention[]; total: number; counts: Record<string, number> }
/**
 * A request opened by its link, read by its identity apart from the queue's pages.
 * `missing`: no such request in this space; `failed`: the read itself did not work.
 */
export interface LinkedAttention { requestId: string; state: 'loading' | 'found' | 'missing' | 'failed'; item?: AgentAttention; error?: string }
/**
 * What a request's quick look shows: the request still being read, an open request
 * with its reply form, one already handled, none with that identity in this space,
 * or a read that failed.
 */
export type AttentionPeekState = 'loading' | 'open' | 'handled' | 'missing' | 'failed'
/** What became of the last reply sent from this console: shown until the next one or a space change. */
interface AttentionReplyOutcome extends AttentionDelivery { requestId: string; title: string }

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
  /** True while the inbox page is shown; only then is the full queue read. */
  const open = ref(false)
  // Unsent replies live here so leaving the inbox and coming back keeps them.
  const drafts = ref<Record<string, AttentionReplyDraft & { revision: number }>>({})
  const responseErrors = ref<Record<string, string>>({})
  const lastReply = ref<AttentionReplyOutcome | null>(null)
  const linked = ref<LinkedAttention | null>(null)
  const loading = ref(false)
  const error = ref('')
  let version = 0
  let previewVersion = 0
  let linkedVersion = 0

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
    const linkedBefore = linkedVersion
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
        // A request opened by its link and not on this page is read again by itself, unless
        // it was already read while this queue was loading; a handled one is final.
        const link = linked.value
        if (link && linkedVersion === linkedBefore && link.item?.status !== 'resolved' && link.item?.status !== 'cancelled'
          && !items.value.some(item => item.requestId === link.requestId)) void loadRequest(link.requestId)
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
  // Reads one request by its exact identity in the current space, open or already handled.
  // A reread of the same request keeps showing what was read before.
  async function loadRequest(requestId: string) {
    const space = spaceId.value
    if (!space || !requestId) return
    const current = ++linkedVersion
    const previous = linked.value?.requestId === requestId ? linked.value.item : undefined
    linked.value = { requestId, state: 'loading', item: previous }
    try {
      const query = new URLSearchParams({ personalSpaceId: space, requestId })
      const item = await getJson<AgentAttention>(`/api/agent-attention/request?${query}`)
      if (current !== linkedVersion || space !== spaceId.value) return
      linked.value = item.personalSpaceId === space ? { requestId, state: 'found', item } : { requestId, state: 'missing' }
    } catch (cause) {
      if (current !== linkedVersion || space !== spaceId.value) return
      linked.value = cause instanceof ApiError && cause.status === 404
        ? { requestId, state: 'missing' }
        : { requestId, state: 'failed', item: previous, error: cause instanceof Error ? cause.message : String(cause) }
    }
  }
  function setSpace(id: string) {
    if (spaceId.value === id) return
    version++; spaceId.value = id; counts.value = {}; items.value = []; total.value = 0
    filteredTotal.value = 0; error.value = ''; open.value = false; loading.value = false
    agentId.value = ''; drafts.value = {}; responseErrors.value = {}; lastReply.value = null
    linkedVersion++; linked.value = null
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
  async function respond(item: AgentAttention, answer: AttentionAnswer) {
    const originalSpace = spaceId.value
    if (!originalSpace || item.personalSpaceId !== originalSpace) throw new Error(t('attention.wrongSpace'))
    const { delivery } = await postJson<{ delivery: AttentionDelivery }>('/api/agent-attention/respond', {
      personalSpaceId: originalSpace, personalProjectId: item.personalProjectId,
      requestId: item.requestId, expectedRevision: item.revision, ...answer,
    })
    if (spaceId.value === originalSpace) {
      lastReply.value = { requestId: item.requestId, title: item.title, ...delivery }
      // The POST has confirmed this reply. A failed refresh must not offer it again.
      items.value = items.value.filter(candidate => candidate.requestId !== item.requestId)
      total.value = Math.max(0, total.value - 1)
      counts.value = { ...counts.value, [item.agentId]: Math.max(0, (counts.value[item.agentId] ?? 0) - 1) }
      if (!agentId.value || agentId.value === item.agentId) filteredTotal.value = Math.max(0, filteredTotal.value - 1)
      delete drafts.value[item.requestId]
      // Answered here: its quick look, and a link back to it, show it as handled without another read.
      linkedVersion++
      linked.value = { requestId: item.requestId, state: 'found', item: { ...item, status: 'resolved', revision: item.revision + 1 } }
      if (previewSpaceId.value === originalSpace) {
        previewItems.value = previewItems.value.filter(candidate => candidate.requestId !== item.requestId)
        previewTotal.value = Math.max(0, previewTotal.value - 1)
      }
      await refresh()
    }
  }
  return {
    spaceId, counts, total, items, filteredTotal, previewItems, previewTotal, previewSpaceId,
    previewLoading, previewLoaded, previewError, agentId, open, loading, error, drafts, responseErrors, lastReply, linked,
    setSpace, show, refresh, refreshPreview, loadRequest, more, respond,
  }
})

/** The inbox route, optionally narrowed to one Agent's requests. */
export function inboxLocation(agentId = '', requestId = '') {
  return {
    path: '/inbox',
    query: { ...(agentId ? { agent: agentId } : {}), ...(requestId ? { request: requestId } : {}) },
  }
}

export function attentionTaskHref(item: AgentAttention) {
  const query = new URLSearchParams({ agent: item.agentId, project: item.personalProjectId })
  if (item.taskId) query.set('task', item.taskId)
  return `/project-agents?${query}${item.taskId ? `#task-${encodeURIComponent(item.taskId)}` : ''}`
}

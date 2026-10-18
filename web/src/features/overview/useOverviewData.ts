import { computed, watch, type Ref } from 'vue'
import { getJson } from '@/api/client'
import type { PersonalProject, ProjectAgentRecord, ProjectAgentTaskRecord } from '@/types'
import type { AgentAttention } from '@/features/project-agents/attention-store'
import { isAgentTaskDataComplete } from '@/features/agent-profile/agent-work-summary'
import { overviewOwnerId, normalizeOverviewTasks } from './overview-data'
import { overviewResource } from './overview-resource'

/** Page-local cache: never writes business state, never survives a space/authority change. */
export function useOverviewData(spaceId: Ref<string>, projects: Ref<PersonalProject[]>) {
  const revoked = overviewResource<boolean>()
  const tasks = overviewResource<{ items: ProjectAgentTaskRecord[]; partial: boolean }>(deny)
  const requests = overviewResource<{ items: AgentAttention[]; total: number; partial: boolean }>(deny)
  const names = overviewResource<{ records: Record<string, ProjectAgentRecord>; partial: boolean }>(deny)
  const denied = computed(() => revoked.state.data === true)
  const allowed = computed(() => new Set(projects.value.map(project => project.project_id)))
  const allowedProject = (id?: string | null) => !id || allowed.value.has(id)
  const taskItems = computed(() => denied.value ? [] : (tasks.state.data?.items ?? []).filter(task => allowedProject(task.personalProjectId)))
  const requestItems = computed(() => denied.value ? [] : (requests.state.data?.items ?? []).filter(item => allowedProject(item.personalProjectId)))
  const agentIds = computed(() => [...new Set([
    ...requestItems.value.map(item => item.agentId),
    ...taskItems.value.map(overviewOwnerId).filter((id): id is string => Boolean(id)),
  ])].slice(0, 40))
  let currentSpace = ''
  function reset() { tasks.reset(); requests.reset(); names.reset() }
  function deny() {
    reset()
    revoked.state.data = true
  }
  async function loadTasks() {
    const id = spaceId.value
    if (!id || denied.value) return
    await tasks.load(async signal => {
      const result = await getJson<unknown>(`/api/project-agent-tasks?${new URLSearchParams({ personalSpaceId: id, limit: '200' })}`, { signal })
      return { items: normalizeOverviewTasks(result, id).filter(task => allowedProject(task.personalProjectId)), partial: !isAgentTaskDataComplete(result, 200) }
    })
  }
  async function loadRequests() {
    const id = spaceId.value
    if (!id || denied.value) return
    await requests.load(async signal => {
      const result = await getJson<{ items: AgentAttention[]; total: number; hasMore?: boolean; truncated?: boolean }>(`/api/agent-attention?${new URLSearchParams({ personalSpaceId: id, status: 'open', limit: '5' })}`, { signal })
      const items = (result.items ?? []).filter(item => item.personalSpaceId === id && item.status === 'open' && allowedProject(item.personalProjectId)).slice(0, 5)
      return { items, total: result.total, partial: result.truncated === true || !Number.isFinite(result.total) || (result.total > 0 && !items.length) }
    })
  }
  async function loadNames() {
    const id = spaceId.value, ids = [...agentIds.value]
    if (!id || denied.value || !ids.length) return
    await names.load(async signal => {
      const records: Record<string, ProjectAgentRecord> = {}
      let partial = false
      for (let index = 0; index < ids.length; index += 6) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const results = await Promise.allSettled(ids.slice(index, index + 6).map(async agentId => {
          const record = await getJson<ProjectAgentRecord>(`/api/project-agents/${encodeURIComponent(agentId)}?${new URLSearchParams({ personalSpaceId: id })}`, { signal }).catch(cause => {
            // Permission loss must not wait for a different name's hung read.
            if (!signal.aborted && (cause?.status === 401 || cause?.status === 403)) deny()
            throw cause
          })
          if (record.personalSpaceId === id && record.agentId === agentId && record.profile) records[agentId] = record
        }))
        for (const result of results) if (result.status === 'rejected') {
          const status = result.reason?.status
          if (status === 401 || status === 403) throw result.reason
          if (status !== 404) partial = true
        }
      }
      return { records, partial }
    })
  }
  watch(spaceId, id => {
    currentSpace = id
    reset(); revoked.reset()
    void loadTasks(); void loadRequests()
  }, { immediate: true, flush: 'sync' })
  watch(projects, (next, previous) => {
    if (currentSpace !== spaceId.value || !previous) return
    const removed = previous.some(project => project.personal_space_id === spaceId.value && !next.some(item => item.project_id === project.project_id))
    if (!removed) return
    // Authoritative shrink: invalidate ALL in-flight rounds before pruning, even
    // when a later directory refresh fails. No removed record can be resurrected.
    const taskPending = tasks.state.loading, requestPending = requests.state.loading
    const taskTime = tasks.state.updatedAt, requestTime = requests.state.updatedAt
    const keptTasks = taskItems.value, keptRequests = requestItems.value
    const previousTasks = tasks.state.data, previousRequests = requests.state.data
    reset()
    if (previousTasks) tasks.state.data = { ...previousTasks, items: keptTasks }
    if (previousRequests) requests.state.data = { ...previousRequests, items: keptRequests, total: keptRequests.length, partial: true }
    tasks.state.updatedAt = taskTime; requests.state.updatedAt = requestTime
    if (taskPending || !previousTasks) void loadTasks()
    if (requestPending || !previousRequests) void loadRequests()
    void loadNames()
  }, { flush: 'sync' })
  watch(() => `${spaceId.value}:${agentIds.value.join('\0')}`, () => {
    names.reset(); void loadNames()
  }, { immediate: true, flush: 'post' })
  function retryScope() { reset(); revoked.reset(); void loadTasks(); void loadRequests() }
  return { tasks: tasks.state, requests: requests.state, names: names.state, denied, taskItems, requestItems,
    loadTasks, loadRequests, loadNames, retryScope }
}

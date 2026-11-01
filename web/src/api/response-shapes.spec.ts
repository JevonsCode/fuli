import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { RESPONSE_INVALID, apiErrorCode } from '@/api/client'
import { listServices } from '@/features/agent-services/agent-services'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { readTopicProposals } from '@/features/agent-profile/topic-proposals'
import { useProjectAgentDetails } from '@/features/project-agents/useProjectAgentDetails'
import { readMigrationPlan, readRestoreChoices } from '@/features/data-format/model'
import { loadJudgmentRecords } from '@/features/judgment/judgment-api'
import { confirmHardDelete, previewHardDelete } from '@/features/knowledge-hard-delete/hard-delete-api'
import { readKnowledgeItem } from '@/features/knowledge-quick-edit/quick-edit-api'
import { listThreads, readThread } from '@/features/roundtables/roundtable-api'
import { useConsoleStore } from '@/stores/console'

// Synthetic answers through the real client: a record the server may leave
// partly empty passes, one that lacks what the console reads is refused.
const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))

const service = {
  serviceId: 'svc-1', kind: 'agent_service', personalSpaceId: null, agentId: null, projectId: null, client: null, sessionId: null,
  appId: null, address: null, purpose: 'Synthetic preview', command: null, pid: null, executable: null, commandLine: null,
  state: 'running', startedAt: '2026-11-01T00:00:00Z', stoppedAt: null, stopReason: null,
  live: { state: 'unknown', process: null, port: null },
}

describe('response shapes accept what the server may leave out', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  it('reads services whose optional columns are null', async () => {
    vi.stubGlobal('fetch', answer({ services: [service], checkedAt: '2026-11-01T00:00:01Z', extra: true }))
    await expect(listServices()).resolves.toMatchObject({ services: [{ serviceId: 'svc-1' }], extra: true })
  })

  it('refuses a service without its live state', async () => {
    vi.stubGlobal('fetch', answer({ services: [{ ...service, live: undefined }], checkedAt: '2026-11-01T00:00:01Z' }))
    const error = await listServices().catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('services.0.live')
  })

  it('reads an attention request with no options, task or detail', async () => {
    const request = { requestId: 'r1', personalSpaceId: 'space-a', personalProjectId: 'p1', agentId: 'a1', kind: 'question',
      title: 'Synthetic', requestedAction: 'Pick one', revision: 1, status: 'open' }
    vi.stubGlobal('fetch', answer({ items: [request], total: 1, counts: { a1: 1 } }))
    const attention = useAgentAttention()
    attention.setSpace('space-a')
    await vi.waitFor(() => expect(attention.previewLoaded).toBe(true))
    expect(attention.previewItems).toHaveLength(1)
    expect(attention.previewError).toBe('')
  })

  it('shows an attention list without counts as a failed read', async () => {
    vi.stubGlobal('fetch', answer({ items: [], total: 0 }))
    const attention = useAgentAttention()
    attention.setSpace('space-a')
    await vi.waitFor(() => expect(attention.previewError).not.toBe(''))
    expect(attention.previewLoaded).toBe(false)
  })

  it('reads capture settings that only carry what the settings version stores', async () => {
    vi.stubGlobal('fetch', answer({ enabled: false, disabledSources: [], updatedAt: null }))
    const store = useConsoleStore()
    await store.loadCapturePolicy()
  })

  it('refuses capture settings without the on/off switch', async () => {
    vi.stubGlobal('fetch', answer({ disabledSources: [] }))
    await expect(useConsoleStore().loadCapturePolicy()).rejects.toThrow('enabled')
  })

  it('reads the up-to-date and unavailable answers of an update check', async () => {
    const links = useClientLinks()
    vi.stubGlobal('fetch', answer({ status: 'up_to_date', checkedAt: '2026-11-01T00:00:00Z', manifestVersion: 3 }))
    await expect(links.check()).resolves.toMatchObject({ status: 'up_to_date' })
    vi.stubGlobal('fetch', answer({ status: 'unavailable', checkedAt: '2026-11-01T00:00:00Z', reason: 'HTTP 503' }))
    await expect(links.check()).resolves.toMatchObject({ status: 'unavailable', reason: 'HTTP 503' })
  })

  it('treats a topic list without proposals as empty', async () => {
    vi.stubGlobal('fetch', answer({}))
    await expect(readTopicProposals('space-a')).resolves.toEqual([])
  })

  it('reads a migration plan with nothing waiting, no retention budget and no notice', async () => {
    vi.stubGlobal('fetch', answer({ digest: null, stores: [], blocked: [], undoable: [], retention: null }))
    await expect(readMigrationPlan()).resolves.toMatchObject({ digest: null, stores: [] })
  })

  it('refuses a migration plan without its stores', async () => {
    vi.stubGlobal('fetch', answer({ digest: null, blocked: [], undoable: [] }))
    const error = await readMigrationPlan().catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('stores')
  })

  it('reads restore choices whose backups carry no version or time and no restore has run', async () => {
    vi.stubGlobal('fetch', answer({
      stores: [{ label: 'Synthetic store', store: 'synthetic', kind: 'json', backups: [{ ref: 'backup-1' }, { ref: 'backup-2', version: null, takenAt: null }] }],
      restore: null,
    }))
    await expect(readRestoreChoices()).resolves.toMatchObject({ stores: [{ backups: [{ ref: 'backup-1' }, { ref: 'backup-2' }] }], restore: null })
  })

  it('reads a thread list with an unnamed participant and no waiting list', async () => {
    const summary = { id: 't1', subject: 'Synthetic', projectId: null, updatedAt: '2026-11-01T00:00:00Z', messageCount: 1,
      participants: [{ agentId: null, name: null, client: null }], waiting: false, last: null }
    vi.stubGlobal('fetch', answer({ threads: [summary] }))
    await expect(listThreads()).resolves.toMatchObject({ threads: [{ id: 't1' }] })
  })

  it('reads a thread without the person-conversation fields older servers leave out', async () => {
    const person = { agentId: null, name: null, client: null }
    const message = { id: 'm1', kind: 'ask', status: 'queued', body: 'Synthetic', inReplyTo: null, via: null, error: null,
      createdAt: '2026-11-01T00:00:00Z', from: person, to: person }
    vi.stubGlobal('fetch', answer({ id: 't1', subject: 'Synthetic', projectId: null, createdAt: '2026-11-01T00:00:00Z', messages: [message], extra: true }))
    await expect(readThread('t1')).resolves.toMatchObject({ messages: [{ id: 'm1' }], extra: true })
  })

  it('refuses a thread message without who sent it', async () => {
    vi.stubGlobal('fetch', answer({ id: 't1', subject: 'Synthetic', createdAt: '2026-11-01T00:00:00Z',
      messages: [{ id: 'm1', kind: 'ask', status: 'queued', body: 'Synthetic', createdAt: '2026-11-01T00:00:00Z', to: {} }] }))
    const error = await readThread('t1').catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('messages.0.from')
  })

  it('reads the record of a permanently deleted item, whose words are gone', async () => {
    const record = { id: 'd1', createdAt: '2026-11-01T00:00:00Z', personalProjectId: null, kind: 'review', outcome: 'approve',
      title: null, summary: null, evidence: [], hard_deleted: true, execution: { status: 'not_applied' },
      feedback: { revision: 0, vote: null, reason: '' }, feedbackHistory: [], executionHistory: [] }
    vi.stubGlobal('fetch', answer({ records: [record], nextCursor: null }))
    await expect(loadJudgmentRecords('space-a', { filter: 'all', search: '' })).resolves.toMatchObject({ records: [{ id: 'd1', summary: null }] })
  })

  it('refuses a judgment record without its execution state', async () => {
    const record = { id: 'd1', createdAt: '2026-11-01T00:00:00Z', kind: 'review', outcome: 'approve', summary: 'Synthetic', evidence: [],
      feedback: { revision: 0, vote: null, reason: '' }, feedbackHistory: [], executionHistory: [] }
    vi.stubGlobal('fetch', answer({ records: [record] }))
    const error = await loadJudgmentRecords('space-a', { filter: 'all', search: '' }).catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('records.0.execution')
  })

  const item = { item_kind: 'entity', item_id: 'item-1', version: 1, title: 'Synthetic', content: 'Synthetic words', type: 'Fact',
    category: 'fact', scope: { kind: 'global', projects: [], status: 'set' }, tags: [], confirmation_status: 'pending' }

  it('reads a knowledge item view that leaves out its optional lists and weight', async () => {
    vi.stubGlobal('fetch', answer({ ...item, evidence: [], evidence_count: 0, revisions: [], weight: null, basis_review: null }))
    await expect(readKnowledgeItem('space-a', 'entity', 'item-1')).resolves.toMatchObject({ item_id: 'item-1', evidence_count: 0 })
  })

  it('refuses a knowledge item view without its scope', async () => {
    const { scope: _scope, ...withoutScope } = item
    vi.stubGlobal('fetch', answer({ ...withoutScope, evidence: [], evidence_count: 0, revisions: [] }))
    const error = await readKnowledgeItem('space-a', 'entity', 'item-1').catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('scope')
  })

  const preview = { preview_id: 'p1', item_kind: 'entity', item_id: 'item-1', title: 'Synthetic', items: [], removed_episodes: [],
    kept_episodes: [], dependents: [], counts: { items: 1, versions: 1 } }

  it('reads a delete preview with no publications, drafts or agent memory', async () => {
    vi.stubGlobal('fetch', answer(preview))
    await expect(previewHardDelete('space-a', { item_kind: 'entity', item_id: 'item-1' })).resolves.toMatchObject({ preview_id: 'p1' })
  })

  it('refuses a delete preview without the id the confirmation is bound to', async () => {
    const { preview_id: _id, ...withoutId } = preview
    vi.stubGlobal('fetch', answer(withoutId))
    const error = await previewHardDelete('space-a', { item_kind: 'entity', item_id: 'item-1' }).catch(cause => cause)
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(error.message).toContain('preview_id')
  })

  it('reads an Agent detail source that is a record holding its list, and refuses one that is plain text', async () => {
    const agent = ref<any>({ agentId: 'a1', personalSpaceId: 'space-a', profile: {}, assignments: [], tasks: [] })
    const details = useProjectAgentDetails({ agents: ref([agent.value]), update: () => {} }, agent, ref('space-a'), { project: ref(''), task: ref('') })
    vi.stubGlobal('fetch', answer({ executors: [], items: [] }))
    await details.refresh()
    expect(details.state('executors')).toMatchObject({ status: 'ready' })
    vi.stubGlobal('fetch', answer('not a record'))
    await details.refresh()
    expect(details.state('executors').status).toBe('error')
    expect(details.state('executors').error).toContain('(root)')
  })

  it('reads the result of a delete whose outcome is not known yet', async () => {
    vi.stubGlobal('fetch', answer({ outcome: 'unknown', item_kind: 'entity', item_id: 'item-1' }))
    await expect(confirmHardDelete('space-a', preview as never, '删除')).resolves.toMatchObject({ outcome: 'unknown' })
  })
})

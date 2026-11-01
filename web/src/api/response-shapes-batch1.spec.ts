import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RESPONSE_INVALID, apiErrorCode } from '@/api/client'
import { listServices } from '@/features/agent-services/agent-services'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useClientLinks } from '@/features/client-links/client-links-store'
import { readTopicProposals } from '@/features/agent-profile/topic-proposals'
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

describe('response shapes of the first API batch', () => {
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
})

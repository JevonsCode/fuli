import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EvidenceRecord } from '@/types'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

import { useSessionLaunchOffers } from './session-launch-offers'

describe('session launch offers', () => {
  beforeEach(() => getJson.mockReset())

  it('asks once for every distinct evidence session and keys the answers', async () => {
    getJson.mockResolvedValue({ launcher: 'available', offers: [
      { sourceApplication: 'codex', sessionId: 'thread-1', client: 'codex', offer: 'link', href: 'codex://threads/thread-1' },
      { sourceApplication: 'claude_code', sessionId: 'session 2', client: 'claude-desktop', offer: 'none' },
    ] })
    const evidence = ref<EvidenceRecord[]>([
      { source_application: 'codex', session_id: 'thread-1' },
      { source_application: 'codex', session_id: 'thread-1' },
      { source_application: 'claude_code', session_id: 'session 2' },
      { source_application: 'cursor' },
    ])
    const offers = useSessionLaunchOffers(evidence)
    await flushPromises()

    expect(getJson).toHaveBeenCalledTimes(1)
    expect(getJson).toHaveBeenCalledWith('/api/session-launch/offers?session=codex%3Athread-1&session=claude_code%3Asession+2')
    expect(offers.value.get('codex:thread-1')?.href).toBe('codex://threads/thread-1')
    expect(offers.value.get('claude_code:session 2')?.offer).toBe('none')
  })

  it('keeps the configured templates when there is no session, no launcher or no answer', async () => {
    const empty = useSessionLaunchOffers(ref([{ source_application: 'codex' }]))
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(empty.value.size).toBe(0)

    getJson.mockResolvedValueOnce({ launcher: 'unavailable', reason: 'not downloaded' })
    const unavailable = useSessionLaunchOffers(ref([{ source_application: 'codex', session_id: 'thread-1' }]))
    getJson.mockRejectedValueOnce(Object.assign(new Error('synthetic 503'), { status: 503 }))
    const failed = useSessionLaunchOffers(ref([{ source_application: 'codex', session_id: 'thread-2' }]))
    await flushPromises()
    expect(unavailable.value.size).toBe(0)
    expect(failed.value.size).toBe(0)
  })
})

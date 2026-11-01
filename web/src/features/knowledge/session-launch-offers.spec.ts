import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

import { useSessionLaunchOffers } from './session-launch-offers'

describe('session launch offers', () => {
  beforeEach(() => getJson.mockReset())

  it('asks once for every distinct session and keys the answers', async () => {
    getJson.mockResolvedValue({ launcher: 'available', offers: [
      { sourceApplication: 'codex', sessionId: 'thread-1', client: 'codex', offer: 'link', href: 'codex://threads/thread-1' },
      { sourceApplication: 'claude_code', sessionId: 'session 2', client: 'claude-desktop', offer: 'none' },
    ] })
    const { offers, pending } = useSessionLaunchOffers(ref(['codex:thread-1', 'codex:thread-1', 'claude_code:session 2', null]))
    expect(pending.value).toBe(true)
    await flushPromises()

    expect(getJson).toHaveBeenCalledTimes(1)
    expect(getJson).toHaveBeenCalledWith('/api/session-launch/offers?session=codex%3Athread-1&session=claude_code%3Asession+2')
    expect(offers.value.get('codex:thread-1')?.href).toBe('codex://threads/thread-1')
    expect(offers.value.get('claude_code:session 2')?.offer).toBe('none')
    expect(pending.value).toBe(false)
  })

  it('keeps the configured templates when there is no session, no launcher or no answer', async () => {
    const empty = useSessionLaunchOffers(ref([null]))
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(empty.offers.value.size).toBe(0)
    expect(empty.pending.value).toBe(false)

    getJson.mockResolvedValueOnce({ launcher: 'unavailable', reason: 'not downloaded' })
    const unavailable = useSessionLaunchOffers(ref(['codex:thread-1']))
    getJson.mockRejectedValueOnce(Object.assign(new Error('synthetic 503'), { status: 503 }))
    const failed = useSessionLaunchOffers(ref(['codex:thread-2']))
    await flushPromises()
    expect(unavailable.offers.value.size).toBe(0)
    expect(failed.offers.value.size).toBe(0)
    expect(failed.pending.value).toBe(false)
  })
})

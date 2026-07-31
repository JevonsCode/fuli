import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson }))

import { useConsoleStore } from './console'

describe('console store policies', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getJson.mockReset()
    patchJson.mockReset()
  })

  it('persists capture policy changes and keeps existing knowledge semantics visible', async () => {
    patchJson.mockResolvedValue({
      enabled: false,
      updatedAt: '2026-07-31T00:00:00Z',
    })
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
    }

    await store.updateCapturePolicy(false)

    expect(patchJson).toHaveBeenCalledWith('/api/capture-policy', { enabled: false })
    expect(store.state.capturePolicy?.enabled).toBe(false)
    expect(store.feedback?.message).toContain('已有知识仍可读取')
  })

  it('leaves the persisted policy unchanged when saving fails', async () => {
    patchJson.mockRejectedValue(new Error('save failed'))
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
    }

    await store.updateCapturePolicy(false)

    expect(store.state.capturePolicy?.enabled).toBe(true)
    expect(store.feedback).toEqual({ message: 'save failed', tone: 'error' })
  })
})

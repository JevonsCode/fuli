import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { ApiError, getJson } from './client'

describe('API client errors', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('localizes an empty HTTP error response', async () => {
    setLocale('en-US', { persist: false })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { status: 503 }),
    ))

    await expect(getJson('/api/state')).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: 'ApiError',
        message: 'Request failed (503)',
        status: 503,
      }),
    )
  })

  it('preserves a server-provided error as runtime content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Provider unavailable', { status: 503 }),
    ))

    await expect(getJson('/api/state')).rejects.toThrow('Provider unavailable')
  })
})

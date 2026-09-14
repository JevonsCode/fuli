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
        message: 'The service is temporarily unavailable. Retry shortly; if it still fails, check Service connections. (503)',
        status: 503,
        detail: '',
      }),
    )
  })

  it('localizes service failures while preserving diagnostic detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Provider unavailable', { status: 503 }),
    ))

    await expect(getJson('/api/state')).rejects.toMatchObject({
      message: '服务暂时无法响应，请稍后重试；如仍失败，请在「服务连接」检查连接状态。(503)',
      detail: 'Provider unavailable',
      status: 503,
    })
  })

  it('preserves actionable server validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Project has changed. Reload before saving.', { status: 409 }),
    ))
    await expect(getJson('/api/state')).rejects.toThrow('Project has changed. Reload before saving.')
  })
})

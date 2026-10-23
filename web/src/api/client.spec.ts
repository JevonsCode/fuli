import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { ApiError, getJson, postJson } from './client'

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
        message: 'The service is temporarily unavailable. Try again shortly. (503)',
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
      message: '服务暂时无法响应，请稍后重试。(503)',
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


it.each(['zh-CN', 'en-US'] as const)('gives code-specific recovery guidance on role-work reads and writes in %s', async locale => {
  setLocale(locale, { persist: false })
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: 'knowledge_recovery_pending', error: 'internal reason' }), { status: 503 })))
  vi.stubGlobal('fetch', fetch)
  const message = locale === 'zh-CN' ? '正在等待图谱确认删除记录，这部分内容暂时读不到。请稍后重试；如果一直这样，运行 `fuli migrate reconcile-knowledge`。'
    : 'Waiting for the graph to confirm deletion records; this content cannot be read yet. Try again later; if it stays this way, run `fuli migrate reconcile-knowledge`.'
  await expect(getJson('/api/role-work/requests')).rejects.toMatchObject({ message, status: 503 })
  await expect(postJson('/api/role-work/requests', { synthetic: true })).rejects.toMatchObject({ message, status: 503 })
  expect(fetch).toHaveBeenCalledTimes(2)
  vi.unstubAllGlobals()
})

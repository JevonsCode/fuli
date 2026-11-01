import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { z } from 'zod'
import { ApiError, RESPONSE_INVALID, RESPONSE_NOT_JSON, apiErrorCode, apiErrorReason, getJson, postJson, putJson } from './client'
import { shapeOf } from './response-shape'

describe('API client errors', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads a web page where data was expected as words, never a JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html><html></html>', { status: 200 })))
    const error = await getJson('/api/state').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe('本机服务没有返回数据（收到的是网页）。FULI 可能正在启动或更新。')
    expect(apiErrorCode(error)).toBe(RESPONSE_NOT_JSON)
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
  const message = locale === 'zh-CN' ? '正在等待图谱确认删除记录，这部分内容暂时读不到。FULI 正在自动重新核对，请稍后再试。'
    : 'Waiting for the graph to confirm deletion records; this content cannot be read yet. FULI is checking again by itself; try again in a moment.'
  await expect(getJson('/api/role-work/requests')).rejects.toMatchObject({ message, status: 503 })
  await expect(postJson('/api/role-work/requests', { synthetic: true })).rejects.toMatchObject({ message, status: 503 })
  expect(fetch).toHaveBeenCalledTimes(2)
  vi.unstubAllGlobals()
})

describe('API response shapes', () => {
  const shape = shapeOf(z.looseObject({ items: z.array(z.looseObject({ id: z.string() })) }))
  const answer = (value: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 })))

  afterEach(() => vi.unstubAllGlobals())

  it('returns a checked answer with the fields the server added left in place', async () => {
    answer({ items: [{ id: 'a', addedLater: true }], total: 1 })
    await expect(getJson('/api/synthetic', shape)).resolves.toEqual({ items: [{ id: 'a', addedLater: true }], total: 1 })
  })

  it('turns an answer of the wrong shape into one error that names the field, never its value', async () => {
    setLocale('en-US', { persist: false })
    answer({ items: [{ id: 'a' }, { id: 42, secret: 'synthetic-private-value' }] })
    const error = await getJson('/api/synthetic', shape).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 200, message: expect.stringContaining('(items.1.id)') })
    expect(apiErrorCode(error)).toBe(RESPONSE_INVALID)
    expect(apiErrorReason(error)).toBe((error as ApiError).message)
    expect(JSON.stringify(error)).not.toContain('synthetic-private-value')
    expect((error as ApiError).message).not.toContain('42')
  })

  it('checks writes too, and keeps a signal passed after the shape', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    await postJson('/api/synthetic', { synthetic: true }, shape, { signal: controller.signal })
    expect(fetch).toHaveBeenCalledWith('/api/synthetic', expect.objectContaining({ method: 'POST', signal: controller.signal, body: '{"synthetic":true}' }))
    fetch.mockResolvedValue(new Response(JSON.stringify({ items: 'nope' }), { status: 200 }))
    await expect(putJson('/api/synthetic', {}, shape)).rejects.toMatchObject({ message: expect.stringContaining('items') })
  })
})

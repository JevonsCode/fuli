import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setLocale } from '@/i18n'
import { ApiError, apiErrorReason, getJson, postJson } from './client'
import { consoleSessionRequired } from './console-session'

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
  const message = locale === 'zh-CN' ? '正在等待图谱确认删除记录，这部分内容暂时读不到。请稍后重试；如果一直这样，运行 fuli migrate reconcile-knowledge。'
    : 'Waiting for the graph to confirm deletion records; this content cannot be read yet. Try again later; if it stays this way, run fuli migrate reconcile-knowledge.'
  await expect(getJson('/api/role-work/requests')).rejects.toMatchObject({ message, status: 503 })
  await expect(postJson('/api/role-work/requests', { synthetic: true })).rejects.toMatchObject({ message, status: 503 })
  expect(fetch).toHaveBeenCalledTimes(2)
  vi.unstubAllGlobals()
})

// rec#11 D-61: a full read without a signed-in console session.
it.each(['zh-CN', 'en-US'] as const)('says a full read needs the console signed in, in %s, once, without redirecting or retrying', async locale => {
  setLocale(locale, { persist: false })
  const answers = [
    new Response(JSON.stringify({ code: 'console_session_required', error: 'internal wording' }), { status: 401 }),
    new Response(JSON.stringify({ records: [] }), { status: 200 }),
  ]
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(answers.shift()))
  vi.stubGlobal('fetch', fetch)
  const href = window.location.href
  const message = locale === 'zh-CN' ? '这部分需要先登录控制台。' : 'This needs the console signed in.'
  const refused = await getJson('/api/judgment/records?personalSpaceId=s').catch(error => error)
  expect(refused).toMatchObject({ message, status: 401 })
  expect(apiErrorReason(refused)).toBe(message)
  expect(consoleSessionRequired.value).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(window.location.href).toBe(href)
  // The person signed in: the same read succeeds and the notice goes.
  await getJson('/api/judgment/records?personalSpaceId=s')
  expect(consoleSessionRequired.value).toBe(false)
  vi.unstubAllGlobals()
})

it('sends the console session token on every request once this origin holds one, and nothing without it', async () => {
  window.localStorage.clear()
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))
  vi.stubGlobal('fetch', fetch)
  await getJson('/api/state')
  expect(fetch.mock.calls[0]![1]?.headers).toBeUndefined()
  window.localStorage.setItem('fuli.consoleSession', 'synthetic-session-token')
  await getJson('/api/graph?spaceId=s')
  await postJson('/api/judgment/review', { personalSpaceId: 's' })
  expect(fetch.mock.calls[1]![1].headers).toEqual({ 'x-fuli-console-session': 'synthetic-session-token' })
  expect(fetch.mock.calls[2]![1].headers).toEqual({ 'content-type': 'application/json', 'x-fuli-console-session': 'synthetic-session-token' })
  window.localStorage.clear()
  vi.unstubAllGlobals()
})


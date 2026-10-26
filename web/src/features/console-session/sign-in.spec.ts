import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { consoleSessionToken } from '@/api/console-session'
import { i18n, setLocale } from '@/i18n'
import { signInFromFragment } from './sign-in'

// rec#11 D-61: the page a sign-in lands on, with synthetic codes and tokens only.
const ORIGIN = 'http://127.0.0.1:2727'

function answer(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

describe('console sign-in page', () => {
  beforeEach(() => { window.localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks() })

  it('takes the code out of the address bar, redeems it same-origin and keeps the token in this origin', async () => {
    const replaceState = vi.fn()
    const fetchImpl = answer(200, { next: '/knowledge?item=s/entity:e1', token: 'synthetic-session-token' })
    const outcome = await signInFromFragment({ location: { hash: '#code=synthetic-code', origin: ORIGIN },
      history: { replaceState }, fetchImpl })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth/console')
    expect(fetchImpl).toHaveBeenCalledWith('/api/console-session/sign-in', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ code: 'synthetic-code' }) }))
    expect(outcome).toEqual({ status: 'signed_in', next: '/knowledge?item=s/entity:e1' })
    expect(consoleSessionToken()).toBe('synthetic-session-token')
  })

  it('never lands outside this origin, whatever the answer says', async () => {
    for (const next of ['//evil.example/', 'https://evil.example/', '/\\evil.example', 42]) {
      const outcome = await signInFromFragment({ location: { hash: '#code=c', origin: ORIGIN }, history: { replaceState: vi.fn() },
        fetchImpl: answer(200, { next, token: 't' }) })
      expect(outcome).toEqual({ status: 'signed_in', next: '/' })
    }
  })

  it('says why when there is no code, the code is refused, or this origin cannot keep the token', async () => {
    const history = { replaceState: vi.fn() }
    expect(await signInFromFragment({ location: { hash: '', origin: ORIGIN }, history, fetchImpl: answer(200, {}) }))
      .toEqual({ status: 'failed', reason: 'missing' })
    expect(await signInFromFragment({ location: { hash: '#code=c', origin: ORIGIN }, history,
      fetchImpl: answer(401, { code: 'console_sign_in_expired' }) })).toEqual({ status: 'failed', reason: 'refused' })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(await signInFromFragment({ location: { hash: '#code=c', origin: ORIGIN }, history,
      fetchImpl: answer(200, { next: '/', token: 't' }) })).toEqual({ status: 'failed', reason: 'unavailable' })
  })

  it.each(['zh-CN', 'en-US'] as const)('shows one pending sign-in, then a refusal in %s without retrying', async locale => {
    setLocale(locale, { persist: false })
    vi.resetModules()
    const signIn = vi.fn().mockResolvedValue({ status: 'failed', reason: 'refused' })
    vi.doMock('./sign-in', () => ({ signInFromFragment: signIn, landOn: vi.fn() }))
    const { default: ConsoleSignIn } = await import('./ConsoleSignIn.vue')
    const wrapper = mount(ConsoleSignIn, { global: { plugins: [i18n] } })
    expect(wrapper.findAll('[role="status"], .growth-loading')).not.toHaveLength(0)
    await flushPromises()
    const failed = wrapper.get('[data-sign-in-failed]')
    expect(failed.text()).not.toContain('fuli open')
    expect(failed.findAll('[data-console-sign-in]')).toHaveLength(1)
    expect(signIn).toHaveBeenCalledTimes(1)
    vi.doUnmock('./sign-in')
  })
})

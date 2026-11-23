import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import { jefaReadFailureReason } from './jefa-read-failure'

beforeEach(() => setLocale('zh-CN', { persist: false }))

// Jevons 11-23: the person reads why, never an error class or an HTTP code.
describe('jefaReadFailureReason', () => {
  it('names each kind of failure in words', () => {
    expect(['HTTP 401', 'HTTP 403', 'HTTP 404', 'HTTP 503', 'TimeoutError', 'AbortError', 'TypeError', 'unknown'].map(jefaReadFailureReason))
      .toEqual(['没有权限', '没有权限', '找不到', '服务暂时不可用', '读取超时', '读取超时', '读取失败', '读取失败'])
  })

  it('reads English too', () => {
    setLocale('en-US', { persist: false })
    expect(jefaReadFailureReason('HTTP 403')).toBe('Not allowed')
  })
})

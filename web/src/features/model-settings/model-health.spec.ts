import { describe, expect, it } from 'vitest'

import { failureReason, healthLine, latestHealth } from './model-health'

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

describe('model health', () => {
  it('says a known reason in plain words and keeps an unknown one as the provider gave it', () => {
    expect(failureReason('auth_failed')).toBe('密钥不对')
    expect(failureReason('synthetic provider text')).toBe('synthetic provider text')
    expect(failureReason(null)).toBe('原因不明')
  })

  it('says in one line whether the latest call answered, why not, or that none was made', () => {
    expect(healthLine({ status: 'ok', at: ago(2), reason: null }, 'zh-CN')).toBe('正常 · 上次回答 2小时前')
    expect(healthLine({ status: 'failing', at: ago(3), reason: 'timeout' }, 'zh-CN')).toBe('没回应：等太久没有回答 · 3小时前')
    expect(healthLine({ status: 'unknown', at: null, reason: null }, 'zh-CN')).toBe('还没调用过')
    expect(healthLine(null, 'zh-CN')).toBe('还没调用过')
  })

  it('puts a failure of any role before an answer, and the latest of each first', () => {
    const failing = { status: 'failing' as const, at: ago(5), reason: 'network' }
    expect(latestHealth([{ status: 'ok', at: ago(1), reason: null }, failing, null])).toEqual(failing)
    const latest = { status: 'ok' as const, at: ago(1), reason: null }
    expect(latestHealth([{ status: 'ok', at: ago(4), reason: null }, latest])).toEqual(latest)
    expect(latestHealth([null, undefined])).toBeNull()
  })
})

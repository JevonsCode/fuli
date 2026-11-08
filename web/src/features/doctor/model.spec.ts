import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { doctorItemView, type DoctorItem } from './model'

const sessions = (runningVersion: string | null): DoctorItem => ({
  id: runningVersion ? `sessions_outdated:other:${runningVersion}` : 'sessions_outdated:other:unknown',
  kind: 'sessions_outdated', severity: 'warning', fix: 'person',
  data: { client: 'other', count: 3, runningVersion, sessions: [] },
})

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('doctorItemView for outdated sessions', () => {
  it('names a very old FULI when the running version is unknown', () => {
    setLocale('zh-CN', { persist: false })
    expect(doctorItemView(sessions(null)).hint).toBe('3 个会话还在用很老的 FULI，重启这些会话就会用上新版。')
    setLocale('en-US', { persist: false })
    expect(doctorItemView(sessions(null)).hint).toBe('3 sessions still run a very old FULI; restart them to load the new version.')
  })

  it('names the running version when there is one', () => {
    setLocale('en-US', { persist: false })
    expect(doctorItemView(sessions('0.21.0')).hint).toBe('3 sessions still run 0.21.0; restart them to load the new version.')
  })
})

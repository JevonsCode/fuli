import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { AgentAppRow } from './agent-apps'
import { appGroup, appStatus, formatBytes } from './app-labels'

// Synthetic apps only.
const app = (patch: Partial<AgentAppRow> = {}): AgentAppRow => ({
  appId: 'app-synthetic', agentId: 'agent-a', name: 'dispatch-log', title: 'Dispatch log', type: 'page', status: 'active',
  version: '1.0.0', pendingVersions: [], approval: null, run: { status: 'ready' }, instance: null, lastUsedAt: null, dataBytes: 2048,
  ...patch,
})

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('app labels', () => {
  it('puts what needs the person first: a new version, or an active app the run gate refuses', () => {
    expect(appGroup(app({ pendingVersions: ['1.1.0'] }))).toBe('attention')
    expect(appStatus(app({ pendingVersions: ['1.1.0'] }))).toEqual({ text: '新版本 1.1.0 等你批准', tone: 'attention' })
    const refused = app({ run: { status: 'run_refused', reason: 'reconfirmation_required' } })
    expect(appGroup(refused)).toBe('attention')
    expect(appStatus(refused).text).toBe('要你重新确认后才能运行')
  })

  it('reads running, ready, a crash and removal from the recorded state alone', () => {
    expect(appGroup(app({ instance: { state: 'running' } }))).toBe('running')
    expect(appStatus(app({ instance: { state: 'running' } }))).toEqual({ text: '运行中', tone: 'running' })
    expect(appStatus(app())).toEqual({ text: '可以运行', tone: 'quiet' })
    expect(appStatus(app({ instance: { state: 'stopped', exit: { category: 'crashed' } } })).tone).toBe('danger')
    expect(appGroup(app({ status: 'code_deleted' }))).toBe('removed')
    expect(appStatus(app({ status: 'code_deleted' })).text).toBe(`代码已删除，数据还在（${formatBytes(2048)}）`)
    // A disabled app is not "waiting" just because the gate refuses it.
    expect(appGroup(app({ status: 'disabled', run: { status: 'run_refused', reason: 'confirmation_required' } }))).toBe('ready')
  })

  it('sizes data in the reader’s language', () => {
    setLocale('en-US', { persist: false })
    expect(formatBytes(512)).toMatch(/^512 /)
    expect(formatBytes(1536)).toMatch(/^1.5 kB$/i)
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB')
  })
})

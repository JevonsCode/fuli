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

const npmCopy = (shellCommands: string[]): DoctorItem => ({
  id: 'npm_copy_installed', kind: 'npm_copy_installed', severity: 'warning', fix: 'person',
  data: { copies: [{ version: '0.12.4', shellCommands }], commands: ["npm uninstall --global fuli-context --prefix '/opt/homebrew'"] },
})

describe('doctorItemView for an npm copy beside the desktop app', () => {
  it('says the terminal still runs it, and gives the one command to remove it', () => {
    setLocale('zh-CN', { persist: false })
    const view = doctorItemView(npmCopy(['fl', 'fuli']))
    expect(view.title).toBe('用 npm 装的 FULI 还在')
    expect(view.hint).toBe('桌面版已接管同一份数据和客户端；终端里的 fl / fuli 仍是旧的 npm 版 v0.12.4。运行下面的命令删掉它，数据不动。')
    expect(view.commands).toEqual(["npm uninstall --global fuli-context --prefix '/opt/homebrew'"])
    expect(view.hint.length).toBeLessThanOrEqual(100)
  })

  it('leaves the terminal out when no command on PATH reaches it', () => {
    setLocale('en-US', { persist: false })
    const view = doctorItemView(npmCopy([]))
    expect(view.hint).toBe('The app now runs your data and clients; npm v0.12.4 is unused. Remove it below; data stays.')
    expect(view.hint.length).toBeLessThanOrEqual(100)
  })
})

import { describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { graphJobLabel, graphRefusal } from './graph-backup-words'
import type { GraphBackupJob } from './model'

const job = (fields: Partial<GraphBackupJob>): GraphBackupJob => ({ id: 'j', action: 'backup', status: 'running', step: null,
  version: 23, backup: null, error: null, started: null, ...fields })

describe('graph backup words', () => {
  it('names the real step of a backup or a restore, in each language', () => {
    setLocale('zh-CN')
    expect(graphJobLabel(job({ step: 'exporting' }))).toBe('正在导出图谱，完成后 FULI 自动回来…')
    expect(graphJobLabel(job({ action: 'restore', step: 'restoring' }))).toBe('正在用备份恢复图谱，完成后 FULI 自动回来…')
    expect(graphJobLabel(job({}))).toBe('正在准备备份图谱…')
    setLocale('en-US')
    expect(graphJobLabel(job({ step: 'starting' }))).toBe('Starting FULI again…')
    setLocale('zh-CN')
  })

  it('words a refusal it knows, keeps the server\'s text otherwise, and sends another computer to the right one', () => {
    expect(graphRefusal({ code: 'graph_lifecycle_locked', hostOnly: false, message: 'x' }, 'graphBackup').text)
      .toBe('没有开始备份：图数据库正被一次维护占着，没有停 FULI；稍后再试。')
    expect(graphRefusal({ code: null, hostOnly: false, message: 'busy' }, 'graphRestore').text).toBe('没有开始恢复：busy。')
    expect(graphRefusal({ code: null, hostOnly: true, message: 'x' }, 'graphRestore'))
      .toEqual({ text: '只能在运行 FULI 的那台电脑上做：在那台电脑的 FULI 应用或它本机的控制台里点同一个按钮。', hostOnly: true })
  })
})

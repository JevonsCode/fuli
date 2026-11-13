import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { AgentAttention } from '@/features/project-agents/attention-store'
import { sparklinePoints, statementSeries, statementTiles, statementValue, statementWeek, type Statement } from './statement'
import { decisionRows, workingRows } from './today-model'
import type { ProjectAgentTaskRecord } from '@/types'
import type { TeamSheet } from '@/features/team-work/team-sheets'

beforeEach(() => setLocale('zh-CN', { persist: false }))
const request = (id: string) => ({ requestId: id }) as AgentAttention

describe('等你拍板 rows', () => {
  it('fills up to five in order: requests, the habits to confirm, then the disagreeing preferences', () => {
    const { rows, more } = decisionRows({ requests: [request('a'), request('b')], requestTotal: 2, reviewTotal: 4, conflicts: 1 })
    expect(rows.map(row => row.kind)).toEqual(['request', 'request', 'review', 'conflicts'])
    expect(more).toBe(0)
  })

  it('counts what no row stands for once five are shown', () => {
    const four = ['a', 'b', 'c', 'd'].map(request)
    const { rows, more } = decisionRows({ requests: four, requestTotal: 6, reviewTotal: 3, conflicts: 2 })
    expect(rows.map(row => row.kind)).toEqual(['request', 'request', 'request', 'request', 'review'])
    expect(more).toBe(2 + 2)
  })
})

describe('正在干活 rows', () => {
  it('keeps only work in progress, its own tasks first, then shared work the list did not have', () => {
    const tasks = [
      { taskId: 'run', status: 'running', leadAgentId: 'lead', personalProjectId: 'p', title: '在做' },
      { taskId: 'stuck', status: 'blocked', leadAgentId: 'lead', personalProjectId: 'p', title: '卡住' },
    ] as ProjectAgentTaskRecord[]
    const sheets = [
      { taskId: 'run', status: 'running', leadAgentId: 'lead', personalProjectId: 'p', title: '在做', shares: [] },
      { taskId: 'team', status: 'running', leadAgentId: 'other', personalProjectId: null, title: ' 一起做 ', shares: [] },
    ] as unknown as TeamSheet[]
    expect(workingRows(tasks, sheets).map(row => [row.key, row.title, row.team])).toEqual([['run', '在做', false], ['team', '一起做', true]])
  })
})

describe('复利账单', () => {
  it('reads one local week from Monday 00:00 to the next Monday 00:00', () => {
    const thursday = new Date(2026, 10, 12, 15, 30)
    const week = statementWeek(thursday)
    expect(new Date(week.from)).toEqual(new Date(2026, 10, 9))
    expect(new Date(week.to)).toEqual(new Date(2026, 10, 16))
    expect(new Date(statementWeek(thursday, 1).from)).toEqual(new Date(2026, 10, 2))
    // Sunday still belongs to the week that started on Monday.
    expect(new Date(statementWeek(new Date(2026, 10, 15, 23)).from)).toEqual(new Date(2026, 10, 9))
  })

  it('treats a section the server names unavailable as missing', () => {
    const statement = { carried: { tasks: 3, clients: 2, items: 9 }, used: { times: 5, tasks: 1, cited: 1, applied: 1 }, unavailable: ['used'] } as Statement
    expect(statementValue(statement, 'used', 'times')).toBeNull()
    expect(statementTiles(statement).map(tile => tile.key)).toEqual(['carried'])
  })

  it('draws a trend only for two or more points that are not all zero', () => {
    expect(sparklinePoints([], 96, 28)).toBeNull()
    expect(sparklinePoints([7], 96, 28)).toBeNull()
    expect(sparklinePoints([0, 0, 0], 96, 28)).toBeNull()
    expect(sparklinePoints([1, 3], 96, 28)).toBe('2,26 94,2')
    expect(sparklinePoints([5, 5], 96, 28)).toBe('2,14 94,14')
  })

  it('orders the running total oldest first', () => {
    const statement = { series: [{ to: '2026-11-09T00:00:00Z', confirmed: 9 }, { to: '2026-11-02T00:00:00Z', confirmed: 4 }] } as Statement
    expect(statementSeries(statement)).toEqual([4, 9])
  })
})

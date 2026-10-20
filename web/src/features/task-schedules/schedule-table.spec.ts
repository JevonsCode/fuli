import { describe, expect, it } from 'vitest'
import { readScheduleTableQuery, scheduleColumnVisible, scheduleTableLocationQuery, visibleSchedules } from './schedule-table'
import type { TaskSchedule } from './task-schedules'

const schedule = (id: string, title: string, nextRunAt: string, overrides: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id, personalSpaceId: 'space-1', personalProjectId: id === 'b' ? 'project-b' : 'project-a', revision: 1, enabled: true,
  body: { title, objective: '', workKind: 'report', requiredCapabilities: [], leadAgentId: null, every: { unit: 'days', count: 1 }, startMode: 'queue', failureThreshold: 3 },
  nextRunAt, pausedReason: null, ...overrides,
})
const names: Record<string, string> = { 'project-a': 'Alpha', 'project-b': '文档站' }
const projectName = (id: string) => names[id] ?? id

describe('schedule table query', () => {
  it('reads filters from the URL and falls back on unknown values', () => {
    expect(readScheduleTableQuery({ q: 'weekly', state: 'paused', sort: 'name' })).toEqual({ search: 'weekly', state: 'paused', sort: 'name' })
    expect(readScheduleTableQuery({ state: 'nope', sort: ['x'] })).toEqual({ search: '', state: 'all', sort: 'next' })
  })

  it('writes only non-default filters and keeps unrelated keys such as the open quick look', () => {
    expect(scheduleTableLocationQuery({ item: 'space-1/a', q: 'old' }, { search: ' digest ', state: 'all', sort: 'next' }))
      .toEqual({ item: 'space-1/a', q: 'digest' })
    expect(scheduleTableLocationQuery({}, { search: '', state: 'circuit_open', sort: 'name' })).toEqual({ state: 'circuit_open', sort: 'name' })
  })
})

describe('visibleSchedules', () => {
  const rows = [
    schedule('a', 'Weekly digest', '2026-10-21T00:00:00Z'),
    schedule('b', 'Link check', '2026-10-20T00:00:00Z', { enabled: false, pausedReason: 'circuit_open' }),
    schedule('c', 'Audit', 'not a date'),
  ]

  it('puts the soonest slot first and a missing time last', () => {
    expect(visibleSchedules(rows, { search: '', state: 'all', sort: 'next' }, projectName, 'en-US').map(row => row.id)).toEqual(['b', 'a', 'c'])
  })

  it('filters by state and by name or project name, ignoring case', () => {
    expect(visibleSchedules(rows, { search: '', state: 'circuit_open', sort: 'next' }, projectName, 'en-US').map(row => row.id)).toEqual(['b'])
    expect(visibleSchedules(rows, { search: '文档', state: 'all', sort: 'next' }, projectName, 'zh-CN').map(row => row.id)).toEqual(['b'])
    expect(visibleSchedules(rows, { search: 'WEEKLY', state: 'all', sort: 'name' }, projectName, 'en-US').map(row => row.id)).toEqual(['a'])
  })

  it('sorts by name when asked', () => {
    expect(visibleSchedules(rows, { search: '', state: 'all', sort: 'name' }, projectName, 'en-US').map(row => row.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('scheduleColumnVisible', () => {
  it('shows low-priority columns only on a wide table unless the person chose', () => {
    expect(scheduleColumnVisible('startMode', 1199, {})).toBe(false)
    expect(scheduleColumnVisible('startMode', 1200, {})).toBe(true)
    expect(scheduleColumnVisible('project', 0, {})).toBe(true)
    expect(scheduleColumnVisible('project', 2000, { project: false })).toBe(false)
    expect(scheduleColumnVisible('threshold', 0, { threshold: true })).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { EmployeeBoardItem } from './task-board-model'
import { CARD_FIELDS_KEY, cardTimes, DEFAULT_CARD_FIELDS, useBoardCardFields, type CardField } from './task-card-fields'

const now = new Date(2026, 10, 4, 12)
const task = (patch: Partial<EmployeeBoardItem> = {}): EmployeeBoardItem => ({ id: 'a', projectId: 'p', title: 'Synthetic', status: 'active',
  updatedAt: new Date(2026, 10, 4, 9).toISOString(), createdAt: new Date(2026, 9, 20, 9).toISOString(), ...patch })
const times = (item: EmployeeBoardItem, fields: CardField[] = [...DEFAULT_CARD_FIELDS]) => cardTimes(item, new Set(fields), now)

beforeEach(() => { setLocale('zh-CN', { persist: false }); localStorage.clear() })
afterEach(() => localStorage.clear())

describe('board card times', () => {
  it('leads with the due date and gives every card a time by default', () => {
    expect(times(task({ dueDate: '2026-11-20' })).map(time => time.text)).toEqual(['11月20日截止', '3小时前更新'])
    expect(times(task()).map(time => time.key)).toEqual(['updated'])
  })

  it('marks a due date that needs attention, by calendar day, and not on finished work', () => {
    expect(times(task({ dueDate: '2026-11-02' }))[0]).toMatchObject({ text: '逾期 2 天', tone: 'overdue' })
    expect(times(task({ dueDate: '2026-11-04' }))[0]).toMatchObject({ text: '今天截止', tone: 'soon' })
    expect(times(task({ dueDate: '2026-11-05' }))[0]).toMatchObject({ text: '明天截止', tone: 'soon' })
    expect(times(task({ dueDate: '2026-11-02', status: 'done' }))[0]).toMatchObject({ text: '11月2日截止' })
    expect(times(task({ dueDate: '2026-11-02', status: 'done' }))[0]?.tone).toBeUndefined()
  })

  it('shows the chosen times the task has, and says how long it has sat in its column', () => {
    const item = task({ status: 'review', startedAt: new Date(2026, 9, 25).toISOString(), columnSince: new Date(2026, 10, 2, 11).toISOString() })
    expect(times(item, ['column', 'started', 'created']).map(time => time.text)).toEqual(['本列 2 天', '10月25日开始', '10月20日创建'])
    expect(times(task({ status: 'done', columnSince: item.columnSince, acceptedAt: new Date(2026, 10, 3).toISOString() }), ['column', 'done']).map(time => time.text)).toEqual(['11月3日完成'])
    expect(times(task({ updatedAt: undefined, createdAt: undefined }), ['updated', 'created', 'started', 'column', 'done', 'due'])).toEqual([])
  })
})

describe('the fields a card shows', () => {
  it('starts on the defaults, remembers a choice, and resets', () => {
    const first = useBoardCardFields()
    expect(first.isDefault.value).toBe(true)
    first.toggle('column')
    first.toggle('summary')
    expect(first.isDefault.value).toBe(false)
    const next = useBoardCardFields()
    expect(next.fields.value.has('column')).toBe(true)
    expect(next.fields.value.has('summary')).toBe(false)
    next.reset()
    expect(useBoardCardFields().isDefault.value).toBe(true)
  })

  it('ignores a stored value it cannot read', () => {
    localStorage.setItem(CARD_FIELDS_KEY, '{broken')
    expect(useBoardCardFields().isDefault.value).toBe(true)
    localStorage.setItem(CARD_FIELDS_KEY, JSON.stringify(['due', 'not-a-field']))
    expect([...useBoardCardFields().fields.value]).toEqual(['due'])
  })
})

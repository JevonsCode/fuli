import { describe, expect, it } from 'vitest'

import { boardColumns, columnKeyOf, isColumnMove, ownColumnLabel, type ProjectBoardSetup } from './project-board-layout'
import { boardItemKey, type EmployeeBoardItem } from './task-board-model'
import { boardDropIndex, projectBoardColumn } from './task-board-projection'

const item = (id: string, status: EmployeeBoardItem['status'], boardColumn?: string): EmployeeBoardItem =>
  ({ id, projectId: 'p', title: id, status, ...(boardColumn ? { boardColumn } : {}) })
const a = item('a', 'planned')
const b = item('b', 'planned')
const c = item('c', 'active')
const items = [a, b, c]
const byStatus = (entry: EmployeeBoardItem) => entry.status
const keys = (slots: ReturnType<typeof projectBoardColumn>) => slots.map((slot) => slot.kind === 'task' ? slot.key : 'slot')
// 待开发 / 发布到测试环境 / 待提测 / 上线 / 已完成: two columns stand for active, none for blocked.
const own: ProjectBoardSetup = { kind: 'builtin', columns: [
  { id: 'col-todo', label: '待开发', mapsTo: 'planned' }, { id: 'col-test', label: '发布到测试环境', mapsTo: 'active' },
  { id: 'col-review', label: '待提测', mapsTo: 'review' }, { id: 'col-live', label: '上线', mapsTo: 'active' },
  { id: 'col-done', label: '已完成', mapsTo: 'done' },
] }

describe('task board columns', () => {
  it('shows the built-in columns unless the project names its own', () => {
    expect(boardColumns(null, items).map(({ key }) => key)).toEqual(['planned', 'active', 'blocked', 'review', 'done'])
    expect(boardColumns({ kind: 'builtin', columns: [] }, items).map(({ key }) => key)).toEqual(['planned', 'active', 'blocked', 'review', 'done'])
    expect(boardColumns(own, items).map(({ label }) => label)).toEqual(['待开发', '发布到测试环境', '待提测', '上线', '已完成'])
  })

  it('adds a built-in column only for a status none of its columns stands for that still has tasks', () => {
    expect(boardColumns(own, [...items, item('d', 'blocked')]).map(({ key }) => key))
      .toEqual(['col-todo', 'col-test', 'col-review', 'col-live', 'col-done', 'blocked'])
  })

  it('places a task in the column it was moved to while that column still stands for its status', () => {
    const columns = boardColumns(own, items)
    expect(columnKeyOf(columns, item('x', 'active', 'col-live'))).toBe('col-live')
    expect(columnKeyOf(columns, item('x', 'active'))).toBe('col-test')
    expect(columnKeyOf(columns, item('x', 'review', 'col-live')), 'its status moved on').toBe('col-review')
    expect(columnKeyOf(boardColumns(null, items), item('x', 'active', 'col-live'))).toBe('active')
  })

  it('accepts only a column of this board other than the current one as a move', () => {
    const columns = boardColumns(own, items)
    const live = item('x', 'active', 'col-live')
    expect(isColumnMove(columns, live, 'col-test')).toBe(true)
    expect(isColumnMove(columns, live, 'col-live')).toBe(false)
    expect(isColumnMove(columns, live, 'active')).toBe(false)
    expect(isColumnMove(columns, live, undefined)).toBe(false)
    expect(isColumnMove(boardColumns(null, items), a, 'active')).toBe(true)
    expect(isColumnMove(boardColumns(null, items), a, 'planned')).toBe(false)
  })

  it('names the project\'s own column on a board of built-in columns', () => {
    expect(ownColumnLabel(own, item('x', 'active', 'col-live'))).toBe('上线')
    expect(ownColumnLabel(own, item('x', 'blocked'))).toBeNull()
    expect(ownColumnLabel(null, item('x', 'active'))).toBeNull()
  })
})

describe('task board projection', () => {
  it('shows canonical columns unchanged without a drag or pending move', () => {
    expect(keys(projectBoardColumn('planned', items, [], null, byStatus))).toEqual(['p:a', 'p:b'])
    expect(keys(projectBoardColumn('active', items, [], null, byStatus))).toEqual(['p:c'])
  })

  it('keeps the drag source in place and adds a placeholder only to another target column', () => {
    const drag = { key: boardItemKey(a), column: 'active', index: 0, height: 90 }
    const source = projectBoardColumn('planned', items, [], drag, byStatus)
    expect(keys(source)).toEqual(['p:a', 'p:b'])
    expect(source[0]).toMatchObject({ dragSource: true })
    expect(projectBoardColumn('active', items, [], drag, byStatus)).toEqual([
      { kind: 'placeholder', key: 'placeholder:p:a', height: 90 },
      expect.objectContaining({ key: 'p:c' }),
    ])
    expect(keys(projectBoardColumn('planned', items, [], { ...drag, column: 'planned' }, byStatus))).toEqual(['p:a', 'p:b'])
    expect(keys(projectBoardColumn('active', items, [], { ...drag, column: null }, byStatus))).toEqual(['p:c'])
  })

  it('shows a pending move in its target column without changing the item', () => {
    const pending = [{ key: boardItemKey(a), column: 'active', index: 5 }]
    expect(keys(projectBoardColumn('planned', items, pending, null, byStatus))).toEqual(['p:b'])
    const target = projectBoardColumn('active', items, pending, null, byStatus)
    expect(keys(target)).toEqual(['p:c', 'p:a'])
    expect(target[1]).toMatchObject({ pending: true, item: a })
    expect(a.status).toBe('planned')
  })

  it('drops a pending move whose task is gone or filtered out', () => {
    const pending = [{ key: 'p:gone', column: 'active', index: 0 }]
    expect(keys(projectBoardColumn('active', items, pending, null, byStatus))).toEqual(['p:c'])
    expect(keys(projectBoardColumn('active', [c], [{ key: 'p:a', column: 'active', index: 0 }], null, byStatus))).toEqual(['p:c'])
  })

  it('places a drop next to the card under the pointer', () => {
    const column = projectBoardColumn('planned', items, [], null, byStatus)
    expect(boardDropIndex(column, 'p:c', 'p:b', 'top')).toBe(1)
    expect(boardDropIndex(column, 'p:c', 'p:b', 'bottom')).toBe(2)
    expect(boardDropIndex(column, 'p:c', null, null)).toBe(2)
    expect(boardDropIndex(column, 'p:a', 'p:b', 'top')).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'

import { boardItemKey, isBoardMove, type EmployeeBoardItem } from './task-board-model'
import { boardDropIndex, projectBoardColumn } from './task-board-projection'

const item = (id: string, status: EmployeeBoardItem['status']): EmployeeBoardItem => ({ id, projectId: 'p', title: id, status })
const a = item('a', 'planned')
const b = item('b', 'planned')
const c = item('c', 'active')
const items = [a, b, c]
const keys = (slots: ReturnType<typeof projectBoardColumn>) => slots.map((slot) => slot.kind === 'task' ? slot.key : 'slot')

describe('task board move rule', () => {
  it('accepts only a real column other than the current one', () => {
    expect(isBoardMove(a, 'active')).toBe(true)
    expect(isBoardMove(a, 'planned')).toBe(false)
    expect(isBoardMove(a, 'archived')).toBe(false)
    expect(isBoardMove(a, undefined)).toBe(false)
  })
})

describe('task board projection', () => {
  it('shows canonical columns unchanged without a drag or pending move', () => {
    expect(keys(projectBoardColumn('planned', items, [], null))).toEqual(['p:a', 'p:b'])
    expect(keys(projectBoardColumn('active', items, [], null))).toEqual(['p:c'])
  })

  it('keeps the drag source in place and adds a placeholder only to another target column', () => {
    const drag = { key: boardItemKey(a), status: 'active' as const, index: 0, height: 90 }
    const source = projectBoardColumn('planned', items, [], drag)
    expect(keys(source)).toEqual(['p:a', 'p:b'])
    expect(source[0]).toMatchObject({ dragSource: true })
    expect(projectBoardColumn('active', items, [], drag)).toEqual([
      { kind: 'placeholder', key: 'placeholder:p:a', height: 90 },
      expect.objectContaining({ key: 'p:c' }),
    ])
    expect(keys(projectBoardColumn('planned', items, [], { ...drag, status: 'planned' }))).toEqual(['p:a', 'p:b'])
    expect(keys(projectBoardColumn('active', items, [], { ...drag, status: null }))).toEqual(['p:c'])
  })

  it('shows a pending move in its target column without changing the item', () => {
    const pending = [{ key: boardItemKey(a), status: 'active' as const, index: 5 }]
    expect(keys(projectBoardColumn('planned', items, pending, null))).toEqual(['p:b'])
    const target = projectBoardColumn('active', items, pending, null)
    expect(keys(target)).toEqual(['p:c', 'p:a'])
    expect(target[1]).toMatchObject({ pending: true, item: a })
    expect(a.status).toBe('planned')
  })

  it('drops a pending move whose task is gone or filtered out', () => {
    const pending = [{ key: 'p:gone', status: 'active' as const, index: 0 }]
    expect(keys(projectBoardColumn('active', items, pending, null))).toEqual(['p:c'])
    expect(keys(projectBoardColumn('active', [c], [{ key: 'p:a', status: 'active', index: 0 }], null))).toEqual(['p:c'])
  })

  it('places a drop next to the card under the pointer', () => {
    const column = projectBoardColumn('planned', items, [], null)
    expect(boardDropIndex(column, 'p:c', 'p:b', 'top')).toBe(1)
    expect(boardDropIndex(column, 'p:c', 'p:b', 'bottom')).toBe(2)
    expect(boardDropIndex(column, 'p:c', null, null)).toBe(2)
    expect(boardDropIndex(column, 'p:a', 'p:b', 'top')).toBe(0)
  })
})

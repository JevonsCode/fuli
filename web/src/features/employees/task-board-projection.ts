import { boardItemKey, type EmployeeBoardItem } from './task-board-model'

// What the board shows while a move is in progress. Canonical items are never
// changed here: a drag adds a placeholder where the card would land, and a
// submitted move shows the card in its target column until the server answers.
// A column is named by its key (project-board-layout.ts): a built-in status
// or one of the project's own columns.

/** A move the board has submitted and the server has not answered yet. */
export interface PendingBoardMove {
  key: string
  column: string
  index: number
}

/** The card being dragged (pointer or keyboard) and where it would land. */
export interface BoardDragProjection {
  key: string
  column: string | null
  index: number
  height: number
}

type BoardSlot =
  | { kind: 'task'; key: string; item: EmployeeBoardItem; pending: boolean; dragSource: boolean }
  | { kind: 'placeholder'; key: string; height: number }

/** The slots of one column: canonical tasks, pending moves in or out, and a drag placeholder. */
export function projectBoardColumn(
  column: string,
  items: readonly EmployeeBoardItem[],
  pending: readonly PendingBoardMove[],
  drag: BoardDragProjection | null,
  columnOf: (item: EmployeeBoardItem) => string,
): BoardSlot[] {
  const pendingByKey = new Map(pending.map((move) => [move.key, move]))
  const slots: BoardSlot[] = items
    .filter((item) => columnOf(item) === column && !pendingByKey.has(boardItemKey(item)))
    .map((item) => {
      const key = boardItemKey(item)
      return { kind: 'task', key, item, pending: false, dragSource: drag?.key === key }
    })
  const byKey = new Map(items.map((item) => [boardItemKey(item), item]))
  for (const move of pending) {
    const item = byKey.get(move.key)
    if (!item || move.column !== column) continue
    slots.splice(clampIndex(move.index, slots.length), 0, { kind: 'task', key: move.key, item, pending: true, dragSource: false })
  }
  const source = drag ? byKey.get(drag.key) : undefined
  if (drag && source && drag.column === column && columnOf(source) !== column) {
    slots.splice(clampIndex(drag.index, slots.length), 0, { kind: 'placeholder', key: `placeholder:${drag.key}`, height: drag.height })
  }
  return slots
}

/** Where a card dropped next to `overKey` lands among a column's other tasks. */
export function boardDropIndex(
  slots: readonly BoardSlot[],
  sourceKey: string,
  overKey: string | null,
  edge: 'top' | 'bottom' | null,
): number {
  const others = slots.filter((slot) => slot.kind === 'task' && slot.key !== sourceKey)
  const position = overKey ? others.findIndex((slot) => slot.key === overKey) : -1
  if (position < 0) return others.length
  return edge === 'bottom' ? position + 1 : position
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(index, length))
}

import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine'
import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element'
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge'

// Pointer drag for the employee task board, on Pragmatic drag and drop.
// The library reports which card or column the pointer is over, draws the
// native drag preview and scrolls near edges. It never reorders or submits
// anything: the board owns the move rules, the projection and the one submit
// path it shares with the keyboard and the "Move to…" menu. Columns are named
// by key (project-board-layout.ts): a built-in status or a project's own column.

const CARD = 'employee-board-card'
const COLUMN = 'employee-board-column'

export interface BoardDropLocation {
  column: string
  /** The card under the pointer, or null over a column's free space. */
  overKey: string | null
  edge: 'top' | 'bottom' | null
}

type DragData = Record<string | symbol, unknown>
type DropTargetRecord = { element: Element; data: DragData }

function isCardOf(boardId: symbol, data: DragData) {
  return data.type === CARD && data.boardId === boardId && typeof data.key === 'string'
}

/** The innermost connected card or column of this board under the pointer. */
function readLocation(boardId: symbol, dropTargets: readonly DropTargetRecord[]): BoardDropLocation | null {
  for (const { element, data } of dropTargets) {
    if (data.boardId !== boardId || !element.isConnected || typeof data.column !== 'string') continue
    if (data.type === CARD && typeof data.key === 'string') {
      const edge = extractClosestEdge(data)
      return { column: data.column, overKey: data.key, edge: edge === 'top' || edge === 'bottom' ? edge : null }
    }
    if (data.type === COLUMN) return { column: data.column, overKey: null, edge: null }
  }
  return null
}

/**
 * A card that drags from its handle and is a drop target for the cards of
 * the same board. `card` is read at event time, so the caller may update it.
 */
export function bindDraggableCard(options: {
  boardId: symbol
  element: HTMLElement
  handle: HTMLElement
  card: { key: string; column: string }
  canDrag: () => boolean
}) {
  const { boardId, element, handle, card } = options
  return combine(
    draggable({
      element,
      dragHandle: handle,
      canDrag: () => options.canDrag(),
      getInitialData: () => ({ type: CARD, boardId, key: card.key }),
    }),
    dropTargetForElements({
      element,
      canDrop: ({ source }) => isCardOf(boardId, source.data),
      getData: ({ input }) => attachClosestEdge(
        { type: CARD, boardId, key: card.key, column: card.column },
        { element, input, allowedEdges: ['top', 'bottom'] },
      ),
    }),
  )
}

/** A column: a drop target for this board's cards; its list scrolls near the edges. */
export function bindDropColumn(options: { boardId: symbol; element: HTMLElement; list: HTMLElement | null; column: string }) {
  const { boardId, element, list, column } = options
  const canScroll = ({ source }: { source: { data: DragData } }) => isCardOf(boardId, source.data)
  return combine(
    dropTargetForElements({
      element,
      canDrop: ({ source }) => isCardOf(boardId, source.data),
      getData: () => ({ type: COLUMN, boardId, column }),
    }),
    ...(list ? [autoScrollForElements({ element: list, canScroll })] : []),
  )
}

/** The board's horizontal scroller follows a card dragged near its edges. */
export function bindBoardScroller(options: { boardId: symbol; element: HTMLElement }) {
  const { boardId } = options
  return autoScrollForElements({ element: options.element, canScroll: ({ source }) => isCardOf(boardId, source.data) })
}

/** Lift, move and drop of this board's cards; a drop outside the board reports `null`. */
export function monitorBoardDrag(options: {
  boardId: symbol
  onStart: (key: string, element: HTMLElement) => void
  onMove: (location: BoardDropLocation | null) => void
  onDrop: (location: BoardDropLocation | null) => void
}) {
  const { boardId } = options
  return monitorForElements({
    canMonitor: ({ source }) => isCardOf(boardId, source.data),
    onDragStart: ({ source }) => options.onStart(String(source.data.key), source.element),
    onDropTargetChange: ({ location }) => options.onMove(readLocation(boardId, location.current.dropTargets)),
    onDrag: ({ location }) => options.onMove(readLocation(boardId, location.current.dropTargets)),
    onDrop: ({ location }) => options.onDrop(readLocation(boardId, location.current.dropTargets)),
  })
}

import { draggable, dropTargetForElements, monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine'
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/attach-closest-edge'
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge/extract-closest-edge'
import { getReorderDestinationIndex } from '@atlaskit/pragmatic-drag-and-drop-hitbox/util/get-reorder-destination-index'

// Pointer reordering of a project's own board columns on the project page,
// on Pragmatic drag and drop like the task board. The list owns the order;
// the up and down buttons are the keyboard way to the same move.

const ROW = 'project-board-column'
type DragData = Record<string | symbol, unknown>
const isRowOf = (listId: symbol, data: DragData) => data.type === ROW && data.listId === listId && typeof data.index === 'number'

/** One column row: dragged from its handle, and a drop target for the rows of the same list. `row.index` is read at event time. */
export function bindColumnRow(options: { listId: symbol; element: HTMLElement; handle: HTMLElement; row: { index: number } }) {
  const { listId, element, handle, row } = options
  return combine(
    draggable({ element, dragHandle: handle, getInitialData: () => ({ type: ROW, listId, index: row.index }) }),
    dropTargetForElements({
      element,
      canDrop: ({ source }) => isRowOf(listId, source.data),
      getData: ({ input }) => attachClosestEdge({ type: ROW, listId, index: row.index }, { element, input, allowedEdges: ['top', 'bottom'] }),
    }),
  )
}

/** A drop on a row of this list reports where the dragged row moves. */
export function monitorColumnReorder(options: { listId: symbol; onReorder: (from: number, to: number) => void }) {
  const { listId } = options
  return monitorForElements({
    canMonitor: ({ source }) => isRowOf(listId, source.data),
    onDrop: ({ source, location }) => {
      const target = location.current.dropTargets.find(({ data }) => isRowOf(listId, data))
      if (!target) return
      const from = source.data.index as number
      const to = getReorderDestinationIndex({ startIndex: from, indexOfTarget: target.data.index as number,
        closestEdgeOfTarget: extractClosestEdge(target.data), axis: 'vertical' })
      if (to !== from) options.onReorder(from, to)
    },
  })
}

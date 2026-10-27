import { t } from '@/i18n'
import { EMPLOYEE_BOARD_STATUSES, type EmployeeBoardItem, type EmployeeBoardStatus } from './task-board-model'

// A project's own board on Jefa's board (Notion 「更好的项目管理」). Jefa keeps
// the five built-in statuses; a project may name its own columns, each
// standing for one of them, or use an external board FULI only links to.

export interface ProjectBoardColumn { id: string; label: string; mapsTo: EmployeeBoardStatus }
export type ProjectBoardSetup =
  | { kind: 'builtin'; columns: ProjectBoardColumn[] }
  | { kind: 'external'; external: { url: string; label?: string } }

/** read_board's projectBoard: revision 0 is the untouched built-in board. */
export interface ProjectBoardRecord {
  projectId: string
  revision: number
  managerAgentId: string | null
  board: ProjectBoardSetup
  updatedAt: string | null
}

/** One column the board shows: a built-in status, or one of the project's own columns (boardColumn). */
export interface BoardColumn {
  key: string
  label: string
  status: EmployeeBoardStatus
  boardColumn?: string
}

function hasOwnColumns(setup: ProjectBoardSetup | null | undefined): setup is { kind: 'builtin'; columns: ProjectBoardColumn[] } {
  return setup?.kind === 'builtin' && setup.columns.length > 0
}

/**
 * The columns a board shows: the built-in ones, or the project's own columns
 * followed by a built-in column for each status none of them stands for that
 * still has tasks, so no task is hidden.
 */
export function boardColumns(setup: ProjectBoardSetup | null | undefined, items: readonly EmployeeBoardItem[]): BoardColumn[] {
  const builtin = EMPLOYEE_BOARD_STATUSES.map(({ value, labelKey }) => ({ key: value, label: t(labelKey), status: value }))
  if (!hasOwnColumns(setup)) return builtin
  const own: BoardColumn[] = setup.columns.map(({ id, label, mapsTo }) => ({ key: id, label, status: mapsTo, boardColumn: id }))
  return [...own, ...builtin.filter(({ status }) => !own.some((column) => column.status === status)
    && items.some((item) => item.status === status))]
}

/** The column a task shows in: the one it was moved to while that column still stands for its status, else the first for its status. */
export function columnKeyOf(columns: readonly BoardColumn[], item: EmployeeBoardItem): string {
  const moved = item.boardColumn
    ? columns.find((column) => column.boardColumn === item.boardColumn && column.status === item.status) : undefined
  return (moved ?? columns.find((column) => column.status === item.status))?.key ?? item.status
}

/**
 * The one move rule every path shares (drag, keyboard, menu): only a column of
 * this board other than the task's current one is a move. Anything else is a
 * no-op and must not reach the server.
 */
export function isColumnMove(columns: readonly BoardColumn[], item: EmployeeBoardItem, key: unknown): key is string {
  return typeof key === 'string' && columns.some((column) => column.key === key) && key !== columnKeyOf(columns, item)
}

/** On a board of built-in columns, the name the task's own project gives its column. */
export function ownColumnLabel(setup: ProjectBoardSetup | null | undefined, item: EmployeeBoardItem): string | null {
  if (!hasOwnColumns(setup)) return null
  const columns = boardColumns(setup, [item])
  const column = columns.find((entry) => entry.key === columnKeyOf(columns, item))
  return column?.boardColumn ? column.label : null
}

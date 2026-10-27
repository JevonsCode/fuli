import type { ProjectBoardRecord } from './project-board-layout'

export type EmployeeBoardStatus = 'planned' | 'active' | 'blocked' | 'review' | 'done'

export interface EmployeeBoardItem {
  id: string
  projectId: string
  title: string
  summary?: string
  status: EmployeeBoardStatus
  /** The project's own column the task was moved to, if the project names its columns. */
  boardColumn?: string
  priority?: 'critical' | 'high' | 'medium' | 'low'
  tags?: string[]
  updatedAt?: string
}

export interface EmployeeProjectBoard {
  project: { id: string; name: string }
  items: EmployeeBoardItem[]
  total: number
  truncated: boolean
  /** How the project's own board is set up (read_board); absent on a public report. */
  projectBoard?: ProjectBoardRecord
}

/** Where a card moves: the built-in status, and the project's own column when it has columns. */
export interface BoardMoveTarget {
  status: EmployeeBoardStatus
  boardColumn?: string
}

/** The built-in columns, in order; a project's own columns each stand for one of them. */
export const EMPLOYEE_BOARD_STATUSES: ReadonlyArray<{ value: EmployeeBoardStatus; labelKey: string }> = [
  { value: 'planned', labelKey: 'employees.allProjects.status.planned' },
  { value: 'active', labelKey: 'employees.allProjects.status.active' },
  { value: 'blocked', labelKey: 'employees.allProjects.status.blocked' },
  { value: 'review', labelKey: 'employees.allProjects.status.review' },
  { value: 'done', labelKey: 'employees.allProjects.status.done' },
]

function isEmployeeBoardStatus(value: unknown): value is EmployeeBoardStatus {
  return EMPLOYEE_BOARD_STATUSES.some((entry) => entry.value === value)
}

/** A task is unique by project and id; the same id can exist in two projects. */
export function boardItemKey(item: Pick<EmployeeBoardItem, 'projectId' | 'id'>) {
  return `${item.projectId}:${item.id}`
}

export function isEmployeeBoardItem(value: unknown): value is EmployeeBoardItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EmployeeBoardItem>
  return typeof item.id === 'string' && typeof item.projectId === 'string' && typeof item.title === 'string'
    && isEmployeeBoardStatus(item.status)
}

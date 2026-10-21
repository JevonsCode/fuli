export type EmployeeBoardStatus = 'planned' | 'active' | 'blocked' | 'review' | 'done'

export interface EmployeeBoardItem {
  id: string
  projectId: string
  title: string
  summary?: string
  status: EmployeeBoardStatus
  priority?: 'critical' | 'high' | 'medium' | 'low'
  tags?: string[]
  updatedAt?: string
}

export interface EmployeeProjectBoard {
  project: { id: string; name: string }
  items: EmployeeBoardItem[]
  total: number
  truncated: boolean
}

/** The board's columns, in order; every move (drag, keyboard, menu) targets one of them. */
export const EMPLOYEE_BOARD_STATUSES: ReadonlyArray<{ value: EmployeeBoardStatus; labelKey: string }> = [
  { value: 'planned', labelKey: 'employees.allProjects.status.planned' },
  { value: 'active', labelKey: 'employees.allProjects.status.active' },
  { value: 'blocked', labelKey: 'employees.allProjects.status.blocked' },
  { value: 'review', labelKey: 'employees.allProjects.status.review' },
  { value: 'done', labelKey: 'employees.allProjects.status.done' },
]

export function isEmployeeBoardStatus(value: unknown): value is EmployeeBoardStatus {
  return EMPLOYEE_BOARD_STATUSES.some((entry) => entry.value === value)
}

/** A task is unique by project and id; the same id can exist in two projects. */
export function boardItemKey(item: Pick<EmployeeBoardItem, 'projectId' | 'id'>) {
  return `${item.projectId}:${item.id}`
}

/**
 * The one status rule every move path shares: only a real column other than
 * the task's current one is a move. Everything else (same column, unknown
 * status) is a no-op and must not reach the server.
 */
export function isBoardMove(item: EmployeeBoardItem, status: unknown): status is EmployeeBoardStatus {
  return isEmployeeBoardStatus(status) && status !== item.status
}

export function isEmployeeBoardItem(value: unknown): value is EmployeeBoardItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EmployeeBoardItem>
  return typeof item.id === 'string' && typeof item.projectId === 'string' && typeof item.title === 'string'
    && isEmployeeBoardStatus(item.status)
}

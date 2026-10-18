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

export function isEmployeeBoardItem(value: unknown): value is EmployeeBoardItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EmployeeBoardItem>
  return typeof item.id === 'string' && typeof item.projectId === 'string' && typeof item.title === 'string'
    && ['planned', 'active', 'blocked', 'review', 'done'].includes(item.status ?? '')
}

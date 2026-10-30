import type { EmployeeBoardStatus, EmployeeProjectBoard } from '@/features/employees/task-board-model'
import type { ProjectAgentTaskRecord, ProjectAgentTaskStatus } from '@/types'

// An Agent's board is a view of the tasks assigned to it (rec#60 D-78), shown
// on the same board as Jefa's with the same column rules; it stores nothing.
// Each task status stands for one built-in column. A cancelled task is
// history, not work: it stays in 经历 and off the board.
const BOARD_STATUS: Record<ProjectAgentTaskStatus, EmployeeBoardStatus | null> = {
  awaiting_recruitment: 'planned',
  backlog: 'planned',
  queued: 'planned',
  running: 'active',
  paused: 'active',
  failed: 'blocked',
  blocked: 'blocked',
  awaiting_review: 'review',
  completed: 'done',
  cancelled: null,
}

export function isBoardTask(task: Pick<ProjectAgentTaskRecord, 'status'>) {
  return Boolean(BOARD_STATUS[task.status])
}

/** One board per project the tasks belong to, in the tasks' own order; projects by name. */
export function agentTaskBoards(tasks: readonly ProjectAgentTaskRecord[], projectName: (projectId: string) => string): EmployeeProjectBoard[] {
  const boards = new Map<string, EmployeeProjectBoard>()
  for (const task of tasks) {
    const status = BOARD_STATUS[task.status]
    if (!status) continue
    const projectId = task.personalProjectId ?? ''
    const board = boards.get(projectId) ?? { project: { id: projectId, name: projectName(projectId) }, items: [], total: 0, truncated: false }
    board.items.push({ id: task.taskId, projectId, title: task.title, status,
      ...(task.objective && task.objective !== task.title ? { summary: task.objective } : {}),
      ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}) })
    board.total = board.items.length
    boards.set(projectId, board)
  }
  return [...boards.values()].sort((a, b) => a.project.name.localeCompare(b.project.name))
}

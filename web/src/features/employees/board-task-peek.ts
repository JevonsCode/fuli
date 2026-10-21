import type { EmployeeBoardItem } from './task-board-model'
import type { JefaReadFailure } from './useJefaBoardLoad'

// A board task's details are a quick look in the URL, ?item=<space>/<id>,
// where the id names the task and the project that owns it. A task id is
// unique only within its project, so both parts are kept; each is
// URI-encoded, so neither can contain the ":" between them.
export type BoardTaskRef = Pick<EmployeeBoardItem, 'projectId' | 'id'>

export function boardTaskPeekId(task: BoardTaskRef) {
  return `${encodeURIComponent(task.projectId)}:${encodeURIComponent(task.id)}`
}

export function readBoardTaskPeekId(value: string): BoardTaskRef | null {
  const parts = value.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  try {
    return { projectId: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) }
  } catch {
    return null
  }
}

const DENIED = ['HTTP 401', 'HTTP 403', 'HTTP 404']

/**
 * An open task closes only on an authoritative answer from the catalog and
 * board reads: the catalog was read in full and has no Jefa, or no longer lets
 * this space read the board or the task's project, or a catalog or board read
 * was refused (401/403/404). A read still pending, timed out or failed for
 * another reason proves nothing, so a shared link stays open. (The task's own
 * get_task failure is shown in its dialog with a retry.)
 */
export function boardTaskAccessRevoked(task: BoardTaskRef, read: {
  template: { permissions: string[] } | null
  /** The catalog was read in full for this space (a null template is then an absent Jefa). */
  catalogRead: boolean
  projects: readonly { id: string }[]
  failures: readonly JefaReadFailure[]
}) {
  if (read.failures.some(failure => (failure.projectId === task.projectId || failure.projectId === '') && DENIED.includes(failure.category))) return true
  if (!read.template) return read.catalogRead
  return !read.template.permissions.includes('board.read') || !read.projects.some(project => project.id === task.projectId)
}

import { ApiError, apiErrorCode, postJson, putJson } from '@/api/client'
import { EMPLOYEE_BOARD_STATUSES, type EmployeeBoardStatus } from '@/features/employees/task-board-model'
import type { ProjectBoardRecord } from '@/features/employees/project-board-layout'
import { t } from '@/i18n'
import type { ProjectTeam, ProjectTeamPerson } from './project-team-api'

// The project page's 「项目看板」: the project's own project manager and board
// on Jefa's board. Every read and write goes through Jefa's tools
// (read_board, configure_project_board) or the project-Agent routes, the same
// interfaces an Agent uses in a conversation.

/** A column while the person edits it; a new one has no id until the server gives it one. */
export interface DraftColumn { key: string; id?: string; label: string; mapsTo: EmployeeBoardStatus }
export interface BoardDraft { kind: 'builtin' | 'external'; columns: DraftColumn[]; url: string; label: string }

const PROJECT_MANAGER_OCCUPATION = { role: 'management', tags: [] as string[] }
const PROJECT_MANAGER_EMOJI = '🧭'
const KNOWN_ERRORS = ['version_conflict', 'project_manager_not_assigned', 'project_manager_peer_role', 'project_board_not_saved', 'assignment_required']

function callJefa<T>(personalSpaceId: string, personalProjectId: string, tool: string, args: Record<string, unknown>) {
  return postJson<T>('/api/employee-templates/jefa/call', { personalSpaceId, personalProjectId, tool, arguments: args })
}

function requestId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

/** read_board carries the board setup; one task is the least it reads. */
export async function readProjectBoard(personalSpaceId: string, personalProjectId: string) {
  return (await callJefa<{ projectBoard: ProjectBoardRecord }>(personalSpaceId, personalProjectId, 'read_board', { limit: 1 })).projectBoard
}

export async function saveProjectBoard(personalSpaceId: string, personalProjectId: string,
  change: { expectedRevision: number; managerAgentId: string | null; board: BoardInput }) {
  return (await callJefa<{ projectBoard: ProjectBoardRecord }>(personalSpaceId, personalProjectId, 'configure_project_board',
    { requestId: requestId('project-page-board'), ...change })).projectBoard
}

/** A new durable Agent with the 管理 occupation, assigned to the project and made its manager in one assignment. */
export async function recruitProjectManager(input: { personalSpaceId: string; projectId: string; projectName: string; name: string; board: BoardInput }) {
  const agentId = requestId('project-manager')
  const responsibility = t('employees.projectBoard.recruitResponsibility', { project: input.projectName })
  await putJson('/api/project-agents', {
    personalSpaceId: input.personalSpaceId, personalProjectId: null, agentId,
    profile: { name: input.name, responsibility, status: 'active', occupationEmoji: PROJECT_MANAGER_EMOJI },
    occupation: PROJECT_MANAGER_OCCUPATION,
  })
  const assignment = await postJson<{ projectBoard?: ProjectBoardRecord }>('/api/project-agent-assignments', {
    personalSpaceId: input.personalSpaceId, personalProjectId: input.projectId, agentId,
    idempotencyKey: `project-board:${agentId}`, responsibility,
    reason: t('employees.projectBoard.recruitReason', { project: input.projectName }),
    projectManager: { board: input.board },
  })
  return { agentId, projectBoard: assignment.projectBoard }
}

/** Who can be the project's manager: its own Agents (lead, members, collaborators), never a peer role. */
export function managerCandidates(team: ProjectTeam | null): ProjectTeamPerson[] {
  if (!team) return []
  const people = [team.lead, ...team.members, ...team.collaborators].filter((person): person is ProjectTeamPerson =>
    Boolean(person) && !person!.peerRole)
  return [...new Map(people.map((person) => [person.agentId, person])).values()]
}

let draftKeys = 0
const draftKey = () => `draft-${++draftKeys}`

export function draftFromRecord(record: ProjectBoardRecord): BoardDraft {
  const board = record.board
  if (board.kind === 'external') return { kind: 'external', columns: [], url: board.external.url, label: board.external.label ?? '' }
  return { kind: 'builtin', columns: board.columns.map((column) => ({ ...column, key: column.id })), url: '', label: '' }
}

/** The built-in columns, as a start the person renames and extends. */
export function builtinDraftColumns(): DraftColumn[] {
  return EMPLOYEE_BOARD_STATUSES.map(({ value, labelKey }) => ({ key: draftKey(), label: t(labelKey), mapsTo: value }))
}

export function newDraftColumn(mapsTo: EmployeeBoardStatus = 'planned'): DraftColumn {
  return { key: draftKey(), label: t('employees.projectBoard.newColumn'), mapsTo }
}

/** Moves one column to another position, keeping the rest in order. */
export function moveDraftColumn(columns: readonly DraftColumn[], from: number, to: number): DraftColumn[] {
  const next = [...columns]
  const [moved] = next.splice(from, 1)
  if (moved) next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}

/** What is wrong with the draft, as a message key, or null when it can be saved. */
export function draftProblem(draft: BoardDraft): string | null {
  if (draft.kind === 'external') {
    try {
      const url = new URL(draft.url.trim())
      return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'employees.projectBoard.invalidUrl'
    } catch { return 'employees.projectBoard.invalidUrl' }
  }
  const labels = draft.columns.map((column) => column.label.trim().toLocaleLowerCase())
  return labels.some((label) => !label) || new Set(labels).size !== labels.length ? 'employees.projectBoard.invalidColumns' : null
}

export type BoardInput =
  | { kind: 'builtin'; columns: { id?: string; label: string; mapsTo: EmployeeBoardStatus }[] }
  | { kind: 'external'; external: { url: string; label?: string } }

export function boardFromDraft(draft: BoardDraft): BoardInput {
  if (draft.kind === 'external') {
    const label = draft.label.trim()
    return { kind: 'external', external: { url: draft.url.trim(), ...(label ? { label } : {}) } }
  }
  return { kind: 'builtin', columns: draft.columns.map(({ id, label, mapsTo }) => ({ ...(id ? { id } : {}), label: label.trim(), mapsTo })) }
}

export function projectBoardErrorMessage(error: unknown) {
  const code = apiErrorCode(error)
  if (code && KNOWN_ERRORS.includes(code)) return t(`employees.projectBoard.errors.${code}`)
  if (error instanceof ApiError && error.detail) {
    try {
      const refusal = (JSON.parse(error.detail) as { error?: unknown }).error
      if (typeof refusal === 'string' && refusal) return refusal
    } catch { /* A plain-text answer is its own message. */ }
  }
  return error instanceof Error && error.message ? error.message : t('employees.projectBoard.loadFailed')
}

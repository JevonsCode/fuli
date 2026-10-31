import { getJson } from '@/api/client'

// rec#11 D-82 task sheets as team work: a task several FLAs share, each with
// its own share of the plan. Progress only ever comes from recorded steps;
// a share without them shows its status and nothing else.
export interface TeamProgress { completed: number; total: number }
export interface TeamStep { id: string; title: string; status: string; agentId?: string | null }
export interface TeamShare { agentId: string; role: string | null; status: string; assignment: string | null; progress: TeamProgress | null }
export interface TeamSheet {
  taskId: string
  personalProjectId: string | null
  title: string
  objective: string | null
  status: string
  leadAgentId: string | null
  updatedAt: string | null
  blocker: { summary?: string | null } | null
  progress: TeamProgress | null
  steps: TeamStep[]
  unassignedSteps: number
  shares: TeamShare[]
}
export interface TeamSheets { partial: boolean; workbenches: TeamSheet[] }

/** Every open task two or more FLAs share in the space (one read for the home page and the island). */
export const readTeamSheets = (personalSpaceId: string, signal?: AbortSignal) =>
  getJson<TeamSheets>(`/api/workbenches?${new URLSearchParams({ personalSpaceId })}`, { signal })

const OPEN = new Set(['queued', 'running', 'blocked', 'paused', 'awaiting_review', 'awaiting_recruitment', 'backlog'])
/** Team work: a task two or more FLAs take part in and that is not finished. */
export const isTeamWork = (sheet: TeamSheet) => sheet.shares.length > 1 && OPEN.has(sheet.status)
/** Running team work is what the island shows. */
export const isRunning = (sheet: TeamSheet) => sheet.status === 'running'

/** The lead keeps the recorded order; anyone else's own share comes first. */
export function sharesFor(sheet: TeamSheet, viewerAgentId: string | null = null): TeamShare[] {
  if (!viewerAgentId || sheet.leadAgentId === viewerAgentId) return leadFirst(sheet)
  return [...sheet.shares.filter(share => share.agentId === viewerAgentId), ...sheet.shares.filter(share => share.agentId !== viewerAgentId)]
}
const leadFirst = (sheet: TeamSheet) => [...sheet.shares.filter(share => share.agentId === sheet.leadAgentId), ...sheet.shares.filter(share => share.agentId !== sheet.leadAgentId)]

/** A share's own to-do list: the plan's steps it holds, in plan order. */
export const stepsOf = (sheet: TeamSheet, agentId: string) => sheet.steps.filter(step => step.agentId === agentId)
/** The step a share is doing now, if its plan says so. */
export const currentStep = (sheet: TeamSheet, agentId: string) => stepsOf(sheet, agentId).find(step => step.status === 'in_progress') ?? null
/** 0–1 from a recorded count, or null when nothing is recorded. */
export const fill = (progress: TeamProgress | null) => (progress && progress.total > 0 ? progress.completed / progress.total : null)

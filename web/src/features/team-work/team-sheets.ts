import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// rec#11 D-82 task sheets as team work: a task several FLAs share, each with
// its own share of the plan. Progress only ever comes from recorded steps;
// a share without them shows its status and nothing else.
const progressSchema = z.looseObject({ completed: z.number(), total: z.number() })
const stepSchema = z.looseObject({ id: z.string(), title: z.string(), status: z.string(), agentId: z.string().nullish() })
const shareSchema = z.looseObject({
  agentId: z.string(),
  role: z.string().nullish(),
  status: z.string(),
  assignment: z.string().nullish(),
  progress: progressSchema.nullable(),
  /** The plan step this share is doing now, if any (older servers leave it out). */
  currentStepId: z.string().nullish(),
})
const sheetSchema = z.looseObject({
  taskId: z.string(),
  personalProjectId: z.string().nullable(),
  title: z.string(),
  objective: z.string().nullable(),
  status: z.string(),
  leadAgentId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  blocker: z.looseObject({ summary: z.string().nullish() }).nullable(),
  progress: progressSchema.nullable(),
  steps: z.array(stepSchema),
  unassignedSteps: z.number(),
  shares: z.array(shareSchema),
})
const sheetsShape = shapeOf(z.looseObject({ partial: z.boolean(), workbenches: z.array(sheetSchema) }))

export type TeamProgress = z.infer<typeof progressSchema>
export type TeamStep = z.infer<typeof stepSchema>
export type TeamShare = z.infer<typeof shareSchema>
export type TeamSheet = z.infer<typeof sheetSchema>

/** Every task one FLA takes part in, as the same sheets (its page's 任务单). */
export const readAgentSheets = (personalSpaceId: string, agentId: string, signal?: AbortSignal) =>
  getJson(`/api/project-agents/${encodeURIComponent(agentId)}/workbenches?${new URLSearchParams({ personalSpaceId })}`, sheetsShape, { signal })

/** Every open task two or more FLAs share in the space (one read for the home page and the island). */
export const readTeamSheets = (personalSpaceId: string, signal?: AbortSignal) =>
  getJson(`/api/workbenches?${new URLSearchParams({ personalSpaceId })}`, sheetsShape, { signal })

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
/** The step a share is doing now: the one the server names, else the plan's step in progress. */
export function currentStepOf(sheet: TeamSheet, share: TeamShare) {
  const steps = stepsOf(sheet, share.agentId)
  if (share.currentStepId !== undefined) return steps.find(step => step.id === share.currentStepId) ?? null
  return steps.find(step => step.status === 'in_progress') ?? null
}
/** 0–1 from a recorded count, or null when nothing is recorded. */
export const fill = (progress: TeamProgress | null) => (progress && progress.total > 0 ? progress.completed / progress.total : null)

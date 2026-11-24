import { z } from 'zod'

import { getJson, patchJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { projectDisplayName } from '@/features/projects/project-origin'
import type { ProjectNaming } from '@/features/projects/temporary-project-name'

// How Agents treat a conflict between external and graph knowledge: one
// default for every personal project, and the projects that chose otherwise.
export const CONFLICT_MODES = ['ask_human', 'agent_decide'] as const
const modeSchema = z.enum(CONFLICT_MODES)
export type ConflictMode = z.infer<typeof modeSchema>

const projectChoiceSchema = z.looseObject({
  personalProjectId: z.string(),
  mode: modeSchema,
  updatedAt: z.string().nullish(),
})
const defaultChoiceSchema = z.looseObject({ mode: modeSchema, updatedAt: z.string().nullish() })
const overviewSchema = z.looseObject({
  default: defaultChoiceSchema,
  projects: z.array(projectChoiceSchema),
})
export type ConflictPolicyOverview = z.infer<typeof overviewSchema>

const overviewShape = shapeOf(overviewSchema)
const defaultShape = shapeOf(defaultChoiceSchema)
// The policy that now applies to one project and whether it is its own choice.
const effectiveShape = shapeOf(projectChoiceSchema.extend({ source: z.enum(['default', 'project']) }))

const ROUTE = '/api/external-knowledge/conflict-policy'

export function readConflictPolicies(signal?: AbortSignal) {
  return getJson(ROUTE, overviewShape, { signal })
}

export function saveDefaultConflictMode(mode: ConflictMode) {
  return patchJson(`${ROUTE}/default`, { mode }, defaultShape)
}

/** mode null removes the project's own choice, so the default applies again. */
export function saveProjectConflictMode(personalSpaceId: string, personalProjectId: string, mode: ConflictMode | null) {
  return patchJson(ROUTE, { personalSpaceId, personalProjectId, mode }, effectiveShape)
}

/** The overview after one project's save: its own choice kept, or gone when it follows the default. */
export function withProjectChoice(
  overview: ConflictPolicyOverview,
  saved: Awaited<ReturnType<typeof saveProjectConflictMode>>,
): ConflictPolicyOverview {
  const others = overview.projects.filter(({ personalProjectId }) => personalProjectId !== saved.personalProjectId)
  if (saved.source === 'default') return { ...overview, projects: others }
  const { personalProjectId, mode, updatedAt } = saved
  return { ...overview, projects: [...others, { personalProjectId, mode, updatedAt }] }
}

/** The exceptions to show, in the person's project order; choices of projects not listed here stay hidden. */
export function projectExceptions(overview: ConflictPolicyOverview, projects: readonly ProjectNaming[]) {
  const modes = new Map(overview.projects.map(({ personalProjectId, mode }) => [personalProjectId, mode]))
  return projects.flatMap((project) => {
    const mode = modes.get(project.project_id)
    return mode ? [{ id: project.project_id, name: projectDisplayName(project), mode }] : []
  })
}

export function projectsFollowingDefault<T extends ProjectNaming>(overview: ConflictPolicyOverview, projects: readonly T[]): T[] {
  const chosen = new Set(overview.projects.map(({ personalProjectId }) => personalProjectId))
  return projects.filter(({ project_id: id }) => !chosen.has(id))
}

export function otherMode(mode: ConflictMode): ConflictMode {
  return mode === 'ask_human' ? 'agent_decide' : 'ask_human'
}

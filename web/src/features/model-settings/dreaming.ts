import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Dreaming on the model page (rec#89): Astro's model reads a project's recent
// sessions and proposes changes, which wait in the person's review queue. One
// read lists every project with its new sessions and its last run (counts only).
const lastRun = z.looseObject({ at: z.string(), status: z.string(), sessions: z.number(), proposed: z.number() })
const project = z.looseObject({ personalProjectId: z.string(), name: z.string(), readiness: z.string(),
  newSessions: z.number().nullable(), lastRun: lastRun.nullable() })
const proposal = z.looseObject({ action: z.string(), seenIn: z.number(), status: z.string() })
const result = z.looseObject({ status: z.string(), sessions: z.number().optional(), proposed: z.array(proposal).optional() })
const stateShape = shapeOf(z.looseObject({ readiness: z.string(), projects: z.array(project) }))
const runShape = shapeOf(result)

export type DreamingProject = z.infer<typeof project>
export type DreamingResult = z.infer<typeof result>
export const readDreaming = () => getJson('/api/dreaming', stateShape)
// fromStart reads every session again instead of only those since the last complete run.
export const startDreaming = (personalProjectId: string, fromStart = false) =>
  postJson('/api/dreaming/run', fromStart ? { personalProjectId, fromStart } : { personalProjectId }, runShape)

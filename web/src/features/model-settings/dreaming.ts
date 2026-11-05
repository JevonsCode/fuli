import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Dreaming on the model page (rec#89): Astro's model reads a project's recent
// sessions and proposes changes, which wait in the person's review queue.
const proposal = z.looseObject({ action: z.string(), seenIn: z.number(), status: z.string() })
const result = z.looseObject({ status: z.string(), sessions: z.number().optional(), proposed: z.array(proposal).optional() })
const run = result.extend({ at: z.string(), personalProjectId: z.string().nullable() })
const stateShape = shapeOf(z.looseObject({ readiness: z.string(), runs: z.array(run) }))
const runShape = shapeOf(result)

export type DreamingRun = z.infer<typeof run>
export const readDreaming = (projectId: string) => getJson(`/api/dreaming?projectId=${encodeURIComponent(projectId)}`, stateShape)
export const startDreaming = (personalProjectId: string) => postJson('/api/dreaming/run', { personalProjectId }, runShape)

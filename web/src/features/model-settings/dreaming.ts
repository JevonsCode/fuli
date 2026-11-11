import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'
import { failureReason } from './model-health'

// Dreaming on the model page (rec#89): Astro's model reads a project's recent
// sessions and proposes changes, which wait in the person's review queue. One
// read lists every project with its new sessions and its last run (counts only).
const lastRun = z.looseObject({ at: z.string(), status: z.string(), sessions: z.number(), proposed: z.number() })
const project = z.looseObject({ personalProjectId: z.string(), name: z.string(), readiness: z.string(),
  newSessions: z.number().nullable(), lastRun: lastRun.nullable() })
const proposal = z.looseObject({ action: z.string(), seenIn: z.number(), status: z.string() })
// modelReceipt.reason: why the model did not answer, on a run that stopped (src/dreaming/run.js).
const result = z.looseObject({ status: z.string(), sessions: z.number().optional(), proposed: z.array(proposal).optional(),
  modelReceipt: z.looseObject({ reason: z.string().nullable().optional() }).nullable().optional() })
const stateShape = shapeOf(z.looseObject({ readiness: z.string(), projects: z.array(project) }))
const runShape = shapeOf(result)

export type DreamingProject = z.infer<typeof project>
export type DreamingResult = z.infer<typeof result>
export const readDreaming = () => getJson('/api/dreaming', stateShape)
// fromStart reads every session again instead of only those since the last complete run.
export const startDreaming = (personalProjectId: string, fromStart = false) =>
  postJson('/api/dreaming/run', fromStart ? { personalProjectId, fromStart } : { personalProjectId }, runShape)

// A run that read its sessions, or had none to read, finished; any other status stopped before it did.
const FINISHED = new Set(['dreamed', 'nothing_to_read'])
const STOPPED = ['model_failed', 'superseded', 'needs_model', 'project_not_approved'] as const

/** Why a run did not finish, in plain words; null for a run that did. */
export function runFailure(status: string, reason?: string | null): string | null {
  if (FINISHED.has(status)) return null
  if (status === 'model_failed' && reason) return failureReason(reason)
  return t(`modelSettings.dreaming.failures.${STOPPED.find(known => known === status) ?? 'other'}`)
}

export const queuedCount = (run?: DreamingResult) => run?.proposed?.filter(entry => entry.status === 'queued').length ?? 0

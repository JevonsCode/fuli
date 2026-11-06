import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Retrieval terms for old knowledge on the model page (rec#92): count what
// lacks terms, test a sample with real searches, then fill the rest.
const stats = z.looseObject({ items: z.number(), with_terms: z.number(), missing: z.number(), roughTokens: z.number() })
const trial = z.looseObject({
  status: z.string(),
  sample: z.number().optional(),
  before: z.number().optional(),
  after: z.number().optional(),
  remaining: z.number().optional(),
  advice: z.string().optional(),
  tokens: z.looseObject({ trial: z.number(), perItem: z.number().optional(), projected: z.number().optional() }).optional(),
})
const run = z.looseObject({ status: z.string(), written: z.number().optional(), tokens: z.number().optional() })
const state = z.looseObject({
  readiness: z.string(), stats: stats.nullable(), trial: trial.nullable(), run: run.nullable(),
  busy: z.looseObject({ kind: z.string(), personalProjectId: z.string() }).nullable(),
})
const stateShape = shapeOf(state)

export type TermsTrial = z.infer<typeof trial>
export type TermsState = z.infer<typeof state>
export const readTerms = (projectId: string) => getJson(`/api/retrieval-terms?projectId=${encodeURIComponent(projectId)}`, stateShape)
export const trialTerms = (personalProjectId: string) => postJson('/api/retrieval-terms/trial', { personalProjectId }, shapeOf(trial))
export const fillTerms = (personalProjectId: string) => postJson('/api/retrieval-terms/fill', { personalProjectId }, shapeOf(run))
export const stopTerms = () => postJson('/api/retrieval-terms/stop', {})

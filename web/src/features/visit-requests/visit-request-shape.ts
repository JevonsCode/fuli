import { z } from 'zod'
import { shapeOf } from '@/api/response-shape'

// What the console reads about work another computer asked for
// (src/visit-requests/http.js, src/http/visitor-access-api-router.js): the
// schemas are the types. Every route answers this computer's loopback only.

export const VISIT_STATES = ['received', 'refused', 'planning', 'awaiting_owner', 'approved', 'running', 'awaiting_review',
  'declined', 'expired', 'cancelled', 'failed', 'unknown', 'kept', 'discarded'] as const
export const REQUESTER_MODES = ['ask_only', 'plan', 'auto', 'trusted'] as const

const planSchema = z.looseObject({
  areas: z.array(z.string()), risks: z.array(z.string()), dependencyChanges: z.boolean(), configChanges: z.boolean(),
  network: z.boolean(), size: z.enum(['s', 'm', 'l']),
})
const changedFileSchema = z.looseObject({ path: z.string(), added: z.number(), removed: z.number() })

const visitRequestSchema = z.looseObject({
  id: z.string(),
  state: z.enum(VISIT_STATES),
  review: z.enum(['ready', 'held']).nullable(),
  holdReason: z.string().nullable(),
  requester: z.looseObject({ key: z.string(), label: z.string(), agentName: z.string().nullable(), source: z.string() }),
  projectId: z.string(),
  agentId: z.string(),
  title: z.string(),
  plan: planSchema.nullable(),
  planError: z.string().nullable(),
  risk: z.looseObject({ level: z.enum(['low', 'medium', 'high']), flags: z.array(z.string()) }).nullable(),
  modeAtReceipt: z.enum(REQUESTER_MODES),
  modeAtDecision: z.enum(REQUESTER_MODES).nullable(),
  decidedBy: z.enum(['owner', 'rule']).nullable(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  result: z.looseObject({
    summary: z.string().nullable(), branch: z.string().nullable(), files: z.array(changedFileSchema).nullable(),
    diffstat: z.looseObject({ files: z.number(), added: z.number(), removed: z.number() }).nullable(),
  }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const eventSchema = z.looseObject({
  from: z.string().nullable(), to: z.string(), by: z.string(), rule: z.string().nullable(),
  checks: z.array(z.looseObject({ name: z.string(), ok: z.boolean() })).nullable(), note: z.string().nullable(), at: z.string(),
})

const visitRequestCardSchema = visitRequestSchema.extend({
  what: z.string(),
  requesterAreas: z.array(z.string()),
  events: z.array(eventSchema),
  diff: z.looseObject({ text: z.string(), truncated: z.boolean() }).nullable(),
})

const requesterSchema = z.looseObject({
  key: z.string(), kind: z.enum(['peer', 'guest']), label: z.string(), mode: z.enum(REQUESTER_MODES), ownDevice: z.boolean(),
})

export type VisitState = typeof VISIT_STATES[number]
export type RequesterMode = typeof REQUESTER_MODES[number]
export type VisitRequest = z.infer<typeof visitRequestSchema>
export type VisitRequestCard = z.infer<typeof visitRequestCardSchema>
export type VisitEvent = z.infer<typeof eventSchema>

export const visitListShape = shapeOf(z.looseObject({
  requests: z.array(visitRequestSchema),
  awaiting: z.looseObject({ count: z.number(), newest: z.array(visitRequestSchema) }),
}))
export const visitCardShape = shapeOf(z.looseObject({ request: visitRequestCardSchema }))
export const visitDecisionShape = shapeOf(z.looseObject({ request: visitRequestSchema }))
export const requestersShape = shapeOf(z.looseObject({ requesters: z.array(requesterSchema), defaultMode: z.enum(REQUESTER_MODES) }))
export const requesterModeShape = shapeOf(z.looseObject({
  requester: requesterSchema,
  effects: z.looseObject({ cancelled: z.array(z.string()), returned: z.array(z.string()) }),
}))

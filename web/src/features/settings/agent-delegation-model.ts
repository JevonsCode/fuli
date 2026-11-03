import { z } from 'zod'
import { shapeOf } from '@/api/response-shape'

// GET /api/agent-delegation and PUT …/categories/:category (rec#11 D-81):
// each category's switch and the latest changes FLAs made for the person.
const operation = z.looseObject({
  id: z.string(),
  at: z.string(),
  route: z.string(),
  category: z.string(),
  actor: z.looseObject({ agentId: z.string().nullable() }),
  reason: z.string(),
  outcome: z.enum(['succeeded', 'failed']),
  undo: z.string(),
})

const agentDelegationSchema = z.looseObject({
  categories: z.array(z.looseObject({ id: z.string(), enabled: z.boolean(), defaultEnabled: z.boolean() })),
  updatedAt: z.string().nullable(),
  operations: z.array(operation),
})

export const agentDelegationShape = shapeOf(agentDelegationSchema)

export type AgentDelegationPolicy = z.infer<typeof agentDelegationSchema>

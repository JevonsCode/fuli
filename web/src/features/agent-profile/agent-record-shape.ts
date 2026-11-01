import { z } from 'zod'
import { shapeFor } from '@/api/response-shape'
import type { ProjectAgentRecord } from '@/types'

// An Agent record as the console API answers it: the identity and profile
// fields every page that shows an Agent relies on. The rest of the record
// (assignments, tasks, policies) passes through as ProjectAgentRecord.
export const projectAgentSchema = z.looseObject({
  agentId: z.string(),
  personalSpaceId: z.string(),
  profile: z.looseObject({
    name: z.string(),
    displayName: z.string().nullish(),
    status: z.string(),
    capabilities: z.array(z.string()),
  }),
})

export const projectAgentShape = shapeFor<ProjectAgentRecord>(projectAgentSchema)

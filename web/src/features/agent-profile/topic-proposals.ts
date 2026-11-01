import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Astro's suggestions to give a recurring topic its own project. The server
// decides which topics qualify; the page only shows them and sends the answer.
const topicProposalSchema = z.looseObject({
  topic: z.string(),
  conversations: z.number(),
  days: z.number(),
})
export type TopicProposal = z.infer<typeof topicProposalSchema>

const topicProposalsShape = shapeOf(z.looseObject({ proposals: z.array(topicProposalSchema).nullish() }))

const topicFormationSchema = z.looseObject({
  personal_project_id: z.string(),
  topic: z.string(),
  lead_agent_id: z.string().nullish(),
  lead_status: z.string(),
  conversations: z.number(),
})
export type TopicFormation = z.infer<typeof topicFormationSchema>
const topicFormationShape = shapeOf(topicFormationSchema)

const topicUndoShape = shapeOf(z.looseObject({
  project_archived: z.boolean(),
  conversations: z.number(),
  ask_again_at: z.number(),
  knowledge_returned: z.number(),
  knowledge_kept: z.number(),
}))

const topicDeclineShape = shapeOf(z.looseObject({
  declined_count: z.number(),
  ask_again_at: z.number(),
}))

export async function readTopicProposals(personalSpaceId: string): Promise<TopicProposal[]> {
  if (!personalSpaceId) return []
  const value = await getJson(
    `/api/topic-proposals?personalSpaceId=${encodeURIComponent(personalSpaceId)}`, topicProposalsShape)
  return value.proposals ?? []
}

export function acceptTopicProposal(personalSpaceId: string, topic: string) {
  return postJson('/api/topic-proposals/accept', { personalSpaceId, topic }, topicFormationShape)
}

/** rec#11 D-86: undo a project Astro formed from a recurring topic. */
export function undoTopicPromotion(personalSpaceId: string, topic: string, personalProjectId: string) {
  return postJson('/api/topic-proposals/undo', { personalSpaceId, topic, personalProjectId }, topicUndoShape)
}

export function declineTopicProposal(personalSpaceId: string, topic: string) {
  return postJson('/api/topic-proposals/decline', { personalSpaceId, topic }, topicDeclineShape)
}

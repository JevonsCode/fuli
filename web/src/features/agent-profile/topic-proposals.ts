import { getJson, postJson } from '@/api/client'

// Astro's suggestions to give a recurring topic its own project. The server
// decides which topics qualify; the page only shows them and sends the answer.
export interface TopicProposal {
  topic: string
  conversations: number
  days: number
}

export interface TopicFormation {
  personal_project_id: string
  topic: string
  lead_agent_id: string | null
  lead_status: string
  conversations: number
}

export async function readTopicProposals(personalSpaceId: string): Promise<TopicProposal[]> {
  if (!personalSpaceId) return []
  const value = await getJson<{ proposals?: TopicProposal[] }>(
    `/api/topic-proposals?personalSpaceId=${encodeURIComponent(personalSpaceId)}`)
  return Array.isArray(value?.proposals) ? value.proposals : []
}

export function acceptTopicProposal(personalSpaceId: string, topic: string) {
  return postJson<TopicFormation>('/api/topic-proposals/accept', { personalSpaceId, topic })
}

/** rec#11 D-86: undo a project Astro formed from a recurring topic. */
export function undoTopicPromotion(personalSpaceId: string, topic: string, personalProjectId: string) {
  return postJson<{ project_archived: boolean, conversations: number, ask_again_at: number }>(
    '/api/topic-proposals/undo', { personalSpaceId, topic, personalProjectId })
}

export function declineTopicProposal(personalSpaceId: string, topic: string) {
  return postJson<{ declined_count: number, ask_again_at: number }>('/api/topic-proposals/decline', { personalSpaceId, topic })
}

import { getJson, postJson, putJson } from '@/api/client'

import type {
  JudgmentDecisionRecord,
  JudgmentFeedbackVote,
  JudgmentPolicy,
  JudgmentPolicySelection,
  JudgmentReviewResult,
} from './judgment-types'

export function judgmentQuery(personalSpaceId: string, personalProjectId?: string | null) {
  const query = new URLSearchParams({ personalSpaceId })
  if (personalProjectId) query.set('personalProjectId', personalProjectId)
  return query.toString()
}

export function loadJudgmentPolicy(personalSpaceId: string, personalProjectId?: string | null) {
  return getJson<JudgmentPolicy>(`/api/judgment/policy?${judgmentQuery(personalSpaceId, personalProjectId)}`)
}

export function saveJudgmentPolicy(
  personalSpaceId: string,
  personalProjectId: string | null | undefined,
  policy: JudgmentPolicySelection | null,
  expectedRevision: number,
) {
  const body: {
    personalSpaceId: string
    personalProjectId?: string
    policy: JudgmentPolicySelection | null
    expectedRevision: number
  } = { personalSpaceId, policy, expectedRevision }
  if (personalProjectId) body.personalProjectId = personalProjectId
  return putJson<JudgmentPolicy>('/api/judgment/policy', body)
}

export function loadJudgmentRecords(personalSpaceId: string, personalProjectId?: string | null) {
  return getJson<{ records: JudgmentDecisionRecord[] }>(
    `/api/judgment/records?${judgmentQuery(personalSpaceId, personalProjectId)}`,
  )
}

export function requestJudgmentReview(personalSpaceId: string, personalProjectId?: string | null, limit = 10) {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return postJson<JudgmentReviewResult>('/api/judgment/review', {
    personalSpaceId,
    ...(personalProjectId ? { personalProjectId } : {}),
    requestId,
    limit,
  })
}

export function submitJudgmentFeedback(
  personalSpaceId: string,
  decisionId: string,
  vote: JudgmentFeedbackVote,
  reason: string,
  expectedRevision: number,
) {
  return postJson<JudgmentDecisionRecord>('/api/judgment/feedback', {
    personalSpaceId,
    decisionId,
    vote,
    reason,
    expectedRevision,
  })
}

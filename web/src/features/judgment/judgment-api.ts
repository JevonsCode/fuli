import { getJson, postJson, putJson } from '@/api/client'

import {
  normalizeJudgmentPolicy,
  policySelection,
  type JudgmentDecisionRecord,
  type JudgmentFeedbackVote,
  type JudgmentPolicy,
  type JudgmentPolicyOverrides,
  type JudgmentPolicySelection,
  type JudgmentRecordPage,
  type JudgmentRecordPageQuery,
  type JudgmentReviewResult,
} from './judgment-types'

const JUDGMENT_PAGE_SIZE = 30

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

export function loadJudgmentPolicyOverrides(personalSpaceId: string) {
  return getJson<JudgmentPolicyOverrides>(`/api/judgment/policies?${judgmentQuery(personalSpaceId)}`)
}

// Gives a project its own policy, starting from the one it uses now (the default).
export async function startProjectJudgmentPolicy(personalSpaceId: string, personalProjectId: string) {
  const current = normalizeJudgmentPolicy(await loadJudgmentPolicy(personalSpaceId, personalProjectId))
  return saveJudgmentPolicy(personalSpaceId, personalProjectId, policySelection(current), current.revision)
}

// One page of the space's records, newest first; after is the previous page's nextCursor.
export function loadJudgmentRecords(personalSpaceId: string, { filter, search, after }: JudgmentRecordPageQuery) {
  const query = new URLSearchParams({ personalSpaceId, limit: String(JUDGMENT_PAGE_SIZE), filter })
  if (search) query.set('search', search)
  if (after) query.set('after', after)
  return getJson<JudgmentRecordPage>(`/api/judgment/records?${query}`)
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

export function undoJudgmentReview(personalSpaceId: string, decisionId: string) {
  return postJson<JudgmentDecisionRecord>('/api/judgment/undo', { personalSpaceId, decisionId })
}

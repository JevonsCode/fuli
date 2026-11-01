import { z } from 'zod'
import { getJson, postJson, putJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'

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

// What the console reads of Tonborg's answers (src/judgment/store.js,
// service.js). The unions stay with the interfaces, so a mode or outcome is
// checked as text (the policy is normalized on arrival anyway). A hard-deleted
// item's record loses its words: its free text becomes null and its evidence
// list empty, so those fields are nullable here.
const policySchema = z.looseObject({
  mode: z.string(), quality: z.string(), client: z.string(),
  revision: z.number(), globalRevision: z.number(), inherited: z.boolean(), personalProjectId: z.string().nullish(),
})

const recordSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  personalProjectId: z.string().nullish(),
  kind: z.string(),
  outcome: z.string(),
  title: z.string().nullish(),
  objective: z.string().nullish(),
  summary: z.string().nullish(),
  evidence: z.array(z.string()),
  confidence: z.number().nullish(),
  policy: z.looseObject({ mode: z.string().nullish() }).nullish(),
  // The ledger's last execution, or { status: 'not_applied' } before any.
  execution: z.looseObject({ status: z.string() }),
  // The last feedback, or { revision: 0, vote: null, reason: '' } before any.
  feedback: z.looseObject({ revision: z.number(), vote: z.string().nullable(), reason: z.string().nullish() }),
  feedbackHistory: z.array(z.unknown()),
  executionHistory: z.array(z.unknown()),
})

const judgmentPolicyShape = shapeFor<JudgmentPolicy>(policySchema)
const judgmentOverridesShape = shapeFor<JudgmentPolicyOverrides>(z.looseObject({
  default: policySchema, overrides: z.array(policySchema),
}))
const judgmentRecordShape = shapeFor<JudgmentDecisionRecord>(recordSchema)
const judgmentPageShape = shapeFor<JudgmentRecordPage>(z.looseObject({
  records: z.array(recordSchema), nextCursor: z.string().nullish(),
}))
// remaining is null for a run that did not count candidates.
const judgmentReviewShape = shapeFor<JudgmentReviewResult>(z.looseObject({
  records: z.array(recordSchema), remaining: z.number().nullish(),
}))

export function judgmentQuery(personalSpaceId: string, personalProjectId?: string | null) {
  const query = new URLSearchParams({ personalSpaceId })
  if (personalProjectId) query.set('personalProjectId', personalProjectId)
  return query.toString()
}

export function loadJudgmentPolicy(personalSpaceId: string, personalProjectId?: string | null) {
  return getJson(`/api/judgment/policy?${judgmentQuery(personalSpaceId, personalProjectId)}`, judgmentPolicyShape)
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
  return putJson('/api/judgment/policy', body, judgmentPolicyShape)
}

export function loadJudgmentPolicyOverrides(personalSpaceId: string) {
  return getJson(`/api/judgment/policies?${judgmentQuery(personalSpaceId)}`, judgmentOverridesShape)
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
  return getJson(`/api/judgment/records?${query}`, judgmentPageShape)
}

export function requestJudgmentReview(personalSpaceId: string, personalProjectId?: string | null, limit = 10) {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return postJson('/api/judgment/review', {
    personalSpaceId,
    ...(personalProjectId ? { personalProjectId } : {}),
    requestId,
    limit,
  }, judgmentReviewShape)
}

export function submitJudgmentFeedback(
  personalSpaceId: string,
  decisionId: string,
  vote: JudgmentFeedbackVote,
  reason: string,
  expectedRevision: number,
) {
  return postJson('/api/judgment/feedback', {
    personalSpaceId,
    decisionId,
    vote,
    reason,
    expectedRevision,
  }, judgmentRecordShape)
}

export function undoJudgmentReview(personalSpaceId: string, decisionId: string) {
  return postJson('/api/judgment/undo', { personalSpaceId, decisionId }, judgmentRecordShape)
}

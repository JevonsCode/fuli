import { z } from 'zod'

import { getJson, patchJson, postJson, putJson } from '@/api/client'
import { shapeFor, shapeOf } from '@/api/response-shape'
import { appendKnowledgeGraphPage, itemConfirmationBasis } from '@/features/knowledge/model'
import { t } from '@/i18n'
import type { KnowledgeGraph, KnowledgeItem } from '@/types'

import type { DelegatedReviews } from './review-list'

// The reads and writes behind the 待决策 list (rec#96). Each one is a route the
// console already had, except the two for 「交给 Tonborg 确认」.

const delegatedEntry = z.looseObject({
  id: z.string(), createdAt: z.string(), personalProjectId: z.string().nullable(), target: z.string(),
  title: z.string().nullable(), summary: z.string(), confidence: z.number().nullable(),
  guess: z.enum(['keep', 'drop', 'edit']).nullable(), question: z.string().nullable(), feedbackRevision: z.number(),
})
const delegatedShape = shapeFor<DelegatedReviews>(z.looseObject({ confirmed: z.array(delegatedEntry), questions: z.array(delegatedEntry) }))
const delegationSchema = z.looseObject({
  enabled: z.boolean(), changedAt: z.string().nullable(), revision: z.number(),
  model: z.looseObject({ connected: z.boolean(), status: z.string(), reason: z.string().nullable() }),
})
export type ReviewDelegation = z.infer<typeof delegationSchema>
const delegationShape = shapeOf(delegationSchema)

const PAGE = 200

/** Every current knowledge item of the space, page by page as the organizer reads them. */
export async function readSpaceKnowledge(spaceId: string, stale: () => boolean): Promise<KnowledgeGraph | null> {
  let graph: KnowledgeGraph | null = null
  let offset = 0
  for (;;) {
    const page = await getJson<KnowledgeGraph>(`/api/graph?${new URLSearchParams({ spaceId, limit: String(PAGE), offset: String(offset) })}`)
    if (stale()) return null
    graph = graph ? appendKnowledgeGraphPage(graph, page) : page
    const next = page.next_offset
    if (!page.truncated || !Number.isInteger(next) || (next as number) <= offset) return graph
    offset = next as number
  }
}

export const readDelegatedReviews = (spaceId: string) =>
  getJson(`/api/judgment/delegated?${new URLSearchParams({ personalSpaceId: spaceId })}`, delegatedShape)

export const readDelegation = (spaceId: string) =>
  getJson(`/api/judgment/delegation?${new URLSearchParams({ personalSpaceId: spaceId })}`, delegationShape)

export const saveDelegation = (spaceId: string, enabled: boolean, expectedRevision: number) =>
  putJson('/api/judgment/delegation', { personalSpaceId: spaceId, enabled, expectedRevision }, delegationShape)

/** 不要: the item stops being current; it can be restored, so nothing asks twice. */
export const dropKnowledgeItem = (spaceId: string, projectId: string | null, item: KnowledgeItem) =>
  patchJson(`/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`, {
    personalSpaceId: spaceId, personalProjectId: projectId, action: 'invalidate', reason: t('reviewList.dropReason'),
  })

/** The person's vote on one of Tonborg's decisions: what Tonborg reads next time it judges. */
export const voteOnReview = (spaceId: string, decisionId: string, vote: 'up' | 'down', reason: string, expectedRevision: number) =>
  postJson('/api/judgment/feedback', { personalSpaceId: spaceId, decisionId, vote, reason, expectedRevision })

/** Takes back one confirmation Tonborg made: the item is pending again. */
export const undoTonborgReview = (spaceId: string, decisionId: string) =>
  postJson('/api/judgment/undo', { personalSpaceId: spaceId, decisionId })

/** At most this many items go in one transaction; the progress moves once per batch. */
export const CONFIRM_BATCH = 25
const batchShape = shapeOf(z.looseObject({ confirmed_count: z.number(), item_keys: z.array(z.string()) }))

/**
 * 全部确认 (Jevons 11-06): the person's own confirmation of several pending
 * items in one request and one transaction, each kept with its own revision.
 * If one moved since the list read it, nothing is saved (409).
 */
export const confirmReviewBatch = (spaceId: string, items: KnowledgeItem[]) =>
  postJson('/api/knowledge/batch-confirmation', {
    personalSpaceId: spaceId, groupKind: 'review', groupValue: 'pending', reason: t('reviewList.confirmAllReason'),
    confirmer: { kind: 'user', label: t('knowledge.domain.actors.currentUser') },
    items: items.map(item => ({ itemId: item.id, itemKind: item.itemKind, ...itemConfirmationBasis(item) })),
  }, batchShape)

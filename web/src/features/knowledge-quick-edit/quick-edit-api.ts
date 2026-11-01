import { z } from 'zod'
import { getJson, patchJson, postJson } from '@/api/client'
import { shapeFor, shapeOf } from '@/api/response-shape'
import type { ItemKind, ItemTag, KnowledgeItemSummary, KnowledgeItemView, RevisionResult, TurnReceipt } from './model'
import { tagProjectId } from './model'
import type { GovernancePreview } from '@/features/knowledge-tags/model'

// The console routes behind a turn receipt's links (rec#20). Content edits and
// deactivation use the item's existing PATCH, tags the tag vocabulary routes.

// What the quick-edit pages read of the Provider's item view, turn receipt and tag
// answers (graph-provider/fuli_graph/knowledge_item_view_models.py). The unions
// stay with the interfaces in model.ts, so a kind or status is checked as text.
// The Provider always writes the fields it defaults (lists, counts), but the
// ones it may leave null are nullish here.
const tagSchema = z.looseObject({ id: z.string(), name: z.string(), namespace: z.string(), status: z.string(), project_id: z.string().nullish() })
const summarySchema = z.looseObject({
  item_kind: z.string(), item_id: z.string(), version: z.number(), title: z.string(), content: z.string(), type: z.string(),
  profile_aspect: z.string().nullish(), category: z.string(),
  scope: z.looseObject({
    kind: z.string(), projects: z.array(z.looseObject({ id: z.string(), name: z.string().nullish(), temporary: z.boolean().nullish() })),
    agent_id: z.string().nullish(), agent_name: z.string().nullish(), status: z.string(),
  }),
  weight: z.looseObject({ percent: z.number(), basis: z.looseObject({}) }).nullish(),
  tags: z.array(tagSchema), confirmation_status: z.string(), content_source: z.string().nullish(), status: z.string().nullish(),
})
const itemShape = shapeFor<KnowledgeItemView>(summarySchema.extend({
  evidence: z.array(z.looseObject({ episode_id: z.string() })),
  evidence_count: z.number(),
  unavailable_sources: z.array(z.looseObject({ episode_id: z.string() })).nullish(),
  revisions: z.array(z.looseObject({ id: z.string(), action: z.string(), reason: z.string(), created_at: z.string() })),
  versions: z.array(z.looseObject({ item_kind: z.string(), item_id: z.string(), content: z.string(), status: z.string(), confirmation_status: z.string() })).nullish(),
  current_item_id: z.string().nullish(),
  bases: z.array(z.looseObject({ item_kind: z.string(), item_id: z.string(), content: z.string(), status: z.string() })).nullish(),
  basis_review: z.string().nullish(),
  dependent_count: z.number().nullish(),
}))
// The turn receipt merges the Provider's batches (src/agents/turn-receipt.js).
const receiptShape = shapeFor<TurnReceipt>(z.looseObject({
  entries: z.array(summarySchema.extend({ change: z.string() })), unchanged_count: z.number(), deleted_count: z.number().nullish(),
}))
// A PATCH names the version an edit wrote and what it did to the conclusions drawn from the item; each may be absent.
const revisionShape = shapeFor<RevisionResult>(z.looseObject({
  version_item_id: z.string().nullish(), dependents_outdated: z.number().nullish(), dependents_changed: z.number().nullish(),
  outcome: z.string().nullish(),
}))
// The answer to a scope or tag change is not read, only that it was an object.
const changedShape = shapeOf(z.looseObject({}))
const candidatesShape = shapeFor<{ candidates?: TagCandidate[] }>(z.looseObject({
  candidates: z.array(z.looseObject({ id: z.string(), name: z.string(), namespace: z.string(), status: z.string(), match: z.string().nullish() })).nullish(),
}))
const createdShape = shapeFor<TagCreated>(z.looseObject({
  outcome: z.string(),
  tag: z.looseObject({ id: z.string(), name: z.string() }).nullish(),
  candidates: z.array(z.looseObject({ id: z.string(), name: z.string() })).nullish(),
  revival: z.looseObject({}).nullish(),
}))

const itemPath = (kind: ItemKind, id: string) => `/api/knowledge/${kind}/${encodeURIComponent(id)}`

export function readKnowledgeItem(spaceId: string, kind: ItemKind, id: string) {
  return getJson(`${itemPath(kind, id)}?${new URLSearchParams({ personalSpaceId: spaceId })}`, itemShape)
}

export function readTurnReceipt(spaceId: string, episodes: string[]) {
  return getJson(`/api/knowledge/turn-receipt?${new URLSearchParams({ personalSpaceId: spaceId,
    episodes: episodes.join(',') })}`, receiptShape)
}

export function saveScope(item: KnowledgeItemSummary, body: object) {
  return postJson(`${itemPath(item.item_kind, item.item_id)}/scope`, body, changedShape)
}

export function reviseItem(item: KnowledgeItemSummary, body: object) {
  return patchJson(itemPath(item.item_kind, item.item_id), body, revisionShape)
}

export interface TagCandidate { id: string; name: string; namespace: string; status: string; match?: string }

export function findTags(spaceId: string, item: KnowledgeItemSummary, query: string) {
  const project = tagProjectId(item)
  return getJson(`/api/knowledge-tags?${new URLSearchParams({
    personalSpaceId: spaceId, q: query, limit: '8', ...(project ? { personalProjectId: project } : {}) })}`, candidatesShape)
}

export function changeTag(spaceId: string, item: KnowledgeItemSummary, action: 'attach' | 'detach',
  tag: Pick<ItemTag, 'id'> & Partial<Pick<ItemTag, 'namespace' | 'project_id'>>) {
  return postJson('/api/knowledge-tags', { action, personalSpaceId: spaceId,
    personalProjectId: tagProjectId(item, tag), tagId: tag.id, itemKind: item.item_kind, itemId: item.item_id }, changedShape)
}

// needs_person: the word belongs to a retired tag that would come back without
// some relations or aliases; nothing changed, the person confirms the preview.
export interface TagCreated { outcome: 'created' | 'existing' | 'needs_decision' | 'needs_person'; tag?: TagCandidate | null;
  candidates?: TagCandidate[]; revival?: GovernancePreview | null }

export function createTag(spaceId: string, item: KnowledgeItemSummary, name: string, reason: string) {
  const project = tagProjectId(item)
  return postJson('/api/knowledge-tags', { action: 'create', personalSpaceId: spaceId,
    personalProjectId: project, namespace: project ? 'project' : 'personal', name, reason }, createdShape)
}

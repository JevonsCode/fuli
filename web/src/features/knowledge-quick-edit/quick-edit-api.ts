import { getJson, patchJson, postJson } from '@/api/client'
import type { ItemKind, ItemTag, KnowledgeItemSummary, KnowledgeItemView, RevisionResult, TurnReceipt } from './model'
import { tagProjectId } from './model'
import type { GovernancePreview } from '@/features/knowledge-tags/model'

// The console routes behind a turn receipt's links (rec#20). Content edits and
// deactivation use the item's existing PATCH, tags the tag vocabulary routes.

const itemPath = (kind: ItemKind, id: string) => `/api/knowledge/${kind}/${encodeURIComponent(id)}`

export function readKnowledgeItem(spaceId: string, kind: ItemKind, id: string) {
  return getJson<KnowledgeItemView>(`${itemPath(kind, id)}?${new URLSearchParams({ personalSpaceId: spaceId })}`)
}

export function readTurnReceipt(spaceId: string, episodes: string[]) {
  return getJson<TurnReceipt>(`/api/knowledge/turn-receipt?${new URLSearchParams({ personalSpaceId: spaceId,
    episodes: episodes.join(',') })}`)
}

export function saveScope(item: KnowledgeItemSummary, body: object) {
  return postJson<unknown>(`${itemPath(item.item_kind, item.item_id)}/scope`, body)
}

export function reviseItem(item: KnowledgeItemSummary, body: object) {
  return patchJson<RevisionResult>(itemPath(item.item_kind, item.item_id), body)
}

export interface TagCandidate { id: string; name: string; namespace: string; status: string; match?: string }

export function findTags(spaceId: string, item: KnowledgeItemSummary, query: string) {
  const project = tagProjectId(item)
  return getJson<{ candidates?: TagCandidate[] }>(`/api/knowledge-tags?${new URLSearchParams({
    personalSpaceId: spaceId, q: query, limit: '8', ...(project ? { personalProjectId: project } : {}) })}`)
}

export function changeTag(spaceId: string, item: KnowledgeItemSummary, action: 'attach' | 'detach',
  tag: Pick<ItemTag, 'id'> & Partial<Pick<ItemTag, 'namespace' | 'project_id'>>) {
  return postJson<unknown>('/api/knowledge-tags', { action, personalSpaceId: spaceId,
    personalProjectId: tagProjectId(item, tag), tagId: tag.id, itemKind: item.item_kind, itemId: item.item_id })
}

// needs_person: the word belongs to a retired tag that would come back without
// some relations or aliases; nothing changed, the person confirms the preview.
export interface TagCreated { outcome: 'created' | 'existing' | 'needs_decision' | 'needs_person'; tag?: TagCandidate | null;
  candidates?: TagCandidate[]; revival?: GovernancePreview | null }

export function createTag(spaceId: string, item: KnowledgeItemSummary, name: string, reason: string) {
  const project = tagProjectId(item)
  return postJson<TagCreated>('/api/knowledge-tags', { action: 'create', personalSpaceId: spaceId,
    personalProjectId: project, namespace: project ? 'project' : 'personal', name, reason })
}

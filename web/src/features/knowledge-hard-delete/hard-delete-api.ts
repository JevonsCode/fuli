import { postJson } from '@/api/client'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import type { HardDeleteKind, HardDeletePreview, HardDeleteResult } from './model'
import type { SourceDeletePreview, SourceDeleteSelection, SourceDeleteTarget } from './source-delete-model'

// The console's loopback routes of a permanent delete (rec#5 C9).

const path = (item: { item_kind: HardDeleteKind; item_id: string }) =>
  `/api/knowledge/${item.item_kind}/${encodeURIComponent(item.item_id)}/hard-delete`

export function previewHardDelete(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) {
  return postJson<HardDeletePreview>(`${path(item)}/preview`, { personalSpaceId: spaceId })
}

/** Where this item's delete stands; it settles a lost answer and finishes local cleanup, never deletes again. */
export function hardDeleteStatus(spaceId: string, item: { item_kind: HardDeleteKind; item_id: string }) {
  return postJson<HardDeleteResult>(`${path(item)}/status`, { personalSpaceId: spaceId })
}

function sourceBody(spaceId: string, target: SourceDeleteTarget, selection: SourceDeleteSelection) {
  return { personalSpaceId: spaceId, ...(target.item_kind === 'session'
    ? { sourceApplication: target.sourceApplication, sessionId: target.sessionId } : {}), ...selection }
}
export function previewSourceDelete(spaceId: string, target: SourceDeleteTarget, selection: SourceDeleteSelection) {
  return postJson<SourceDeletePreview>(`${path(target)}/preview`, sourceBody(spaceId, target, selection))
}
export function confirmSourceDelete(spaceId: string, target: SourceDeleteTarget, preview: SourceDeletePreview, confirmation: string) {
  return postJson<HardDeleteResult>(path(target), { ...sourceBody(spaceId, target, { include: preview.include, exclude: preview.exclude }),
    previewId: preview.preview_id, confirmation: confirmation.trim() })
}

export function confirmHardDelete(spaceId: string, preview: HardDeletePreview, confirmation: string) {
  return postJson<HardDeleteResult>(path(preview), { personalSpaceId: spaceId, previewId: preview.preview_id,
    confirmation: confirmation.trim() })
}

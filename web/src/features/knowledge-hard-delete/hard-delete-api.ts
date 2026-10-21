import { postJson } from '@/api/client'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import type { HardDeletePreview, HardDeleteResult } from './model'

// The console's loopback routes of a permanent delete (rec#5 C9).

const path = (item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) =>
  `/api/knowledge/${item.item_kind}/${encodeURIComponent(item.item_id)}/hard-delete`

export function previewHardDelete(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) {
  return postJson<HardDeletePreview>(`${path(item)}/preview`, { personalSpaceId: spaceId })
}

export function confirmHardDelete(spaceId: string, preview: HardDeletePreview, confirmation: string) {
  return postJson<HardDeleteResult>(path(preview), { personalSpaceId: spaceId, previewId: preview.preview_id,
    confirmation: confirmation.trim() })
}

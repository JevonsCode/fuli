import { ApiError } from '@/api/client'
import type { ItemKind, VersionStatus } from '@/features/knowledge-quick-edit/model'

// rec#5 C9: a person's permanent delete of one knowledge item. The payloads
// of its preview and result, and the small decisions the dialog and the item
// page make from them; the components only compose.

export type HardDeleteRole = 'item' | 'version' | 'relationship'

export interface HardDeleteItem {
  item_kind: ItemKind
  item_id: string
  role: HardDeleteRole
  title: string
  content: string
  status: VersionStatus
}

export interface HardDeleteEpisode {
  episode_id: string
  source_kind?: string | null
  source_application?: string | null
  session_id?: string | null
  excerpt?: string | null
  created_at?: string | null
  other_items: number
}

export interface HardDeleteDependent { item_kind: ItemKind; item_id: string; title: string; content: string; direct: boolean }

export const RECORD_COUNTS = ['mentions', 'revisions', 'feedback', 'usage', 'change_audits', 'tags', 'assignments',
  'references', 'review_decisions', 'conflicts', 'promotions', 'decision_snapshots'] as const
export type RecordCount = typeof RECORD_COUNTS[number]

export type HardDeleteCounts = Record<RecordCount | 'items' | 'versions' | 'relationships' | 'episodes'
  | 'kept_episodes' | 'dependents', number>

export interface HardDeletePreview {
  preview_id: string
  item_kind: ItemKind
  item_id: string
  title: string
  items: HardDeleteItem[]
  removed_episodes: HardDeleteEpisode[]
  kept_episodes: HardDeleteEpisode[]
  dependents: HardDeleteDependent[]
  counts: HardDeleteCounts
}

export interface LocalStoreResult { store: string; status: 'forgotten' | 'failed'; changed?: number; reason?: string }

export interface HardDeleteResult {
  deletion_id: string
  item_kind: ItemKind
  item_id: string
  deleted_at: string
  counts: HardDeleteCounts
  deleted_item_ids: string[]
  local_stores?: LocalStoreResult[]
}

/** What the page shows once the item is gone: when, and what the delete reported. */
export interface HardDeletedState { deletedAt: string | null; result?: HardDeleteResult }

const CONFIRMATION_WORDS = new Set(['删除', 'delete'])

/** The person typed 删除 / delete or the item's title (the provider checks it again). */
export function confirmationMatches(preview: Pick<HardDeletePreview, 'title'>, typed: string) {
  const value = typed.trim()
  return Boolean(value) && (CONFIRMATION_WORDS.has(value) || value === preview.title.trim())
}

/** The record counts worth a line in the preview, in a stable order. */
export function recordCounts(counts: HardDeleteCounts): { key: RecordCount; count: number }[] {
  return RECORD_COUNTS.filter((key) => counts[key] > 0).map((key) => ({ key, count: counts[key] }))
}

function apiCode(error: unknown): { code?: string; deletedAt?: string } | null {
  if (!(error instanceof ApiError) || !error.detail) return null
  try {
    return JSON.parse(error.detail) as { code?: string; deletedAt?: string }
  } catch {
    return null
  }
}

/** A read or write answered that the item was permanently deleted (410). */
export function hardDeletedFrom(error: unknown): HardDeletedState | null {
  if (!(error instanceof ApiError) || error.status !== 410) return null
  const body = apiCode(error)
  return body?.code === 'hard_deleted' ? { deletedAt: body.deletedAt ?? null } : null
}

/** The delete was refused because what it removes changed since the preview (409). */
export function stalePreview(error: unknown) {
  return error instanceof ApiError && error.status === 409 && apiCode(error)?.code === 'hard_delete_preview_stale'
}

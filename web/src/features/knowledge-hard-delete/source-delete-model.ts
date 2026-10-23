import type { HardDeleteCounts, HardDeleteItem, HardDeletePreview } from './model'

export interface SourceDeleteTarget {
  item_kind: 'episode' | 'session'
  item_id: string
  sourceApplication?: string
  sessionId?: string
}
export interface SourceDeleteSelection { include: string[]; exclude: string[] }
export interface SourceDeleteRow {
  key: string
  selected: boolean
  reason: 'sole_source' | 'attached_relationship' | 'multiple_sources' | 'derived'
  basis_changed: boolean
  source_count: number
  retained_source_count: number
  versions: HardDeleteItem[]
}
export interface SourceDeletePreview extends Omit<HardDeletePreview, 'item_kind' | 'items' | 'kept_episodes' | 'dependents'>,
  SourceDeleteSelection {
  item_kind: 'episode' | 'session'
  source_application: string | null
  fuli_session_id: string | null
  default_items: SourceDeleteRow[]
  affected_items: SourceDeleteRow[]
  counts: HardDeleteCounts & { source_turns: number; conversation_events: number; conversation_summaries: number }
}

// Shared display only. The source preview and its exact selection remain the
// authority for confirmation; display adaptation never invents a route ID.
export function sourcePreviewDetails(value: SourceDeletePreview) {
  return { ...value, items: [], kept_episodes: [], dependents: [] }
}

export function sourceSelection(value: SourceDeleteSelection, key: string, selected: boolean, defaultLayer: boolean): SourceDeleteSelection {
  return { include: [...value.include.filter(item => item !== key), ...(!defaultLayer && selected ? [key] : [])],
    exclude: [...value.exclude.filter(item => item !== key), ...(defaultLayer && !selected ? [key] : [])] }
}

/** Only a resolved Provider session can name a whole-session deletion. */
export function sessionDeleteTarget(session: { deletionTargetId?: string; sourceApplication: string | null; sessionId: string }): SourceDeleteTarget | null {
  return session.deletionTargetId && session.sourceApplication && session.sessionId
    ? { item_kind: 'session', item_id: session.deletionTargetId, sourceApplication: session.sourceApplication, sessionId: session.sessionId } : null
}

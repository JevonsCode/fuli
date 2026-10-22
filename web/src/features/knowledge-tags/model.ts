import { t } from '@/i18n'

// The tag vocabulary page (rec#11 D-07 part 2): payloads of the console's tag
// routes and the few mappings the page shows. The Provider decides every rule;
// this module only labels, groups and reads its answers.

export type TagStatus = 'provisional' | 'active' | 'merged' | 'retired'
export type TagNamespace = 'personal' | 'project'
export type GovernanceChange = 'approve' | 'merge' | 'split' | 'retire' | 'remove_alias' | 'relate' | 'unrelate' | 'undo'
  | 'revive'
export type RelationKind = 'parent' | 'related'
export type StatusFilter = TagStatus | 'review' | ''

export interface TagRef { id: string; name: string; namespace: TagNamespace; status: TagStatus }

export interface TagEntry extends TagRef {
  project_id: string | null
  description: string | null
  aliases: string[]
  provisional_aliases: string[]
  proposed_aliases: string[]
  linked_items: number | null
  parents: TagRef[]
  related: TagRef[]
  merged_into: TagRef | null
  needs_review: boolean
  source: { kind: 'agent' | 'human'; application: string | null; reason: string }
  version: number
  created_at: string
  updated_at: string
}

export interface TagVocabulary { tags: TagEntry[]; total: number; next_offset: number | null; review_count: number }

export interface TagLinkedItem {
  item_kind: 'entity' | 'relationship'
  item_id: string
  title: string | null
  attached_at: string | null
  moved_from: TagRef | null
}

export interface TagHistoryEntry {
  action: string
  actor_kind: 'agent' | 'human'
  reason: string | null
  created_at: string
  version: number
  operation_id: string | null
  alias: string | null
  relation: RelationKind | null
  other: TagRef | null
  undone: boolean
  undoable: boolean
}

export interface TagDetail {
  tag: TagEntry
  children: TagRef[]
  merged_from: TagRef[]
  // A split-back of a merge that moves in batches and is not finished yet.
  unfinished_restores: { tag: TagRef; remaining: number }[]
  links: TagLinkedItem[] | null
  links_truncated: boolean
  history: TagHistoryEntry[]
}

export interface RelationDrop { tag: TagRef; relation: RelationKind; target: TagRef; reason: 'cycle' | 'self' | 'scope' | 'limit' | 'gone' }

export interface GovernancePreview {
  change: GovernanceChange
  tag: TagRef
  other: TagRef | null
  status_after: TagStatus | null
  new_tag_name: string | null
  revives: boolean
  links_moved: number | null
  links_already_on_target: number | null
  links_remaining: number | null
  aliases: string[]
  aliases_dropped: string[]
  relations_moved: number
  relations_dropped: RelationDrop[]
  undo: { operation_id: string; action: string; created_at: string; restores: TagRef[] } | null
  blocked: { code: string; message: string } | null
  digest: string
}

// restoreTagId: split a mistaken merge back; the Provider moves every item that
// merge took, from its own record, so links stays empty.
export interface SplitChoice { name: string; description: string; aliases: string[]; links: TagLinkedItem[]; restoreTagId?: string }

/** What a governance change sends besides the space: the same body previews and applies it. */
export interface GovernanceRequest {
  change: GovernanceChange
  tagId: string
  intoTagId?: string
  targetTagId?: string
  relation?: RelationKind
  alias?: string
  operationId?: string
  split?: { name: string; description: string | null; aliases: string[]; links: { itemKind: string; itemId: string }[] }
    | { restoreTagId: string; aliases: string[] }
}

export function governanceRequest(change: GovernanceChange, tag: TagRef, choice: {
  target?: TagRef | null; relation?: RelationKind; alias?: string; operationId?: string; split?: SplitChoice
} = {}): GovernanceRequest | null {
  const base = { change, tagId: tag.id }
  if (change === 'merge') return choice.target ? { ...base, intoTagId: choice.target.id } : null
  if (change === 'relate' || change === 'unrelate') {
    return choice.target && choice.relation ? { ...base, targetTagId: choice.target.id, relation: choice.relation } : null
  }
  if (change === 'remove_alias') return choice.alias ? { ...base, alias: choice.alias } : null
  if (change === 'undo') return choice.operationId ? { ...base, operationId: choice.operationId } : base
  if (change === 'split') {
    const split = choice.split
    if (split?.restoreTagId) return { ...base, split: { restoreTagId: split.restoreTagId, aliases: split.aliases } }
    if (!split?.name.trim()) return null
    return { ...base, split: { name: split.name.trim(), description: split.description.trim() || null,
      aliases: split.aliases, links: split.links.map(link => ({ itemKind: link.item_kind, itemId: link.item_id })) } }
  }
  return base
}

export function statusLabel(status: TagStatus) {
  return t(`knowledgeTags.status.${status}`)
}

export function statusTone(status: TagStatus): 'warning' | 'success' | 'secondary' | 'outline' {
  return status === 'provisional' ? 'warning' : status === 'active' ? 'success' : status === 'merged' ? 'secondary' : 'outline'
}

export const isLive = (tag: TagRef) => tag.status === 'provisional' || tag.status === 'active'

export function namespaceLabel(tag: Pick<TagEntry, 'namespace' | 'project_id'>, projectNames: ReadonlyMap<string, string>) {
  if (tag.namespace === 'personal') return t('knowledgeTags.namespace.personal')
  const id = tag.project_id ?? ''
  return t('knowledgeTags.namespace.project', { project: projectNames.get(id) || id })
}

export interface TagGroup { key: string; label: string; tags: TagEntry[] }

/** One group per namespace, the personal vocabulary first, in the order the Provider sent. */
export function groupByNamespace(tags: readonly TagEntry[], projectNames: ReadonlyMap<string, string>): TagGroup[] {
  const groups = new Map<string, TagGroup>()
  for (const tag of tags) {
    const key = tag.namespace === 'personal' ? 'personal' : `project:${tag.project_id ?? ''}`
    if (!groups.has(key)) groups.set(key, { key, label: namespaceLabel(tag, projectNames), tags: [] })
    groups.get(key)!.tags.push(tag)
  }
  return [...groups.values()]
}

/** What the person is about to do, in sentences, from the Provider's preview. */
export function previewLines(preview: GovernancePreview): string[] {
  const lines: string[] = []
  const name = preview.tag.name
  const other = preview.other?.name ?? ''
  if (preview.change === 'approve') lines.push(t('knowledgeTags.preview.approve', { name }))
  if (preview.change === 'revive') lines.push(t('knowledgeTags.preview.revive', { name }))
  if (preview.change === 'retire') lines.push(t('knowledgeTags.preview.retire', { name }))
  if (preview.change === 'merge') {
    lines.push(t('knowledgeTags.preview.merge', { name, other }))
    if (preview.links_moved !== null) {
      lines.push(t('knowledgeTags.preview.mergeLinks', { moved: preview.links_moved,
        kept: preview.links_already_on_target ?? 0, other }))
    }
  }
  if (preview.change === 'split') {
    lines.push(t(preview.revives ? 'knowledgeTags.preview.splitRevives' : 'knowledgeTags.preview.split',
      { name, other: preview.new_tag_name ?? other }))
    if (preview.links_moved !== null) {
      lines.push(t(preview.revives ? 'knowledgeTags.preview.splitLinksBack' : 'knowledgeTags.preview.splitLinks',
        { count: preview.links_moved, other: preview.new_tag_name ?? preview.other?.name ?? '' }))
    }
    if (preview.aliases.length) lines.push(t('knowledgeTags.preview.splitAliases', { aliases: preview.aliases.join('、') }))
    if (preview.links_remaining) lines.push(t('knowledgeTags.preview.splitBatch', { count: preview.links_remaining }))
  }
  if (preview.aliases_dropped.length) {
    lines.push(t('knowledgeTags.preview.aliasesDropped', { aliases: preview.aliases_dropped.join('、') }))
  }
  if (preview.change === 'remove_alias') lines.push(t('knowledgeTags.preview.removeAlias', { name, alias: preview.aliases[0] ?? '' }))
  if (preview.change === 'relate' || preview.change === 'unrelate') {
    lines.push(t(`knowledgeTags.preview.${preview.change}`, { name, other }))
  }
  if (preview.change === 'merge' && preview.relations_moved) {
    lines.push(t('knowledgeTags.preview.relationsMoved', { count: preview.relations_moved, other }))
  }
  for (const drop of preview.relations_dropped) {
    lines.push(t(`knowledgeTags.preview.dropped.${drop.reason}`, { tag: drop.tag.name, target: drop.target.name }))
  }
  if (preview.undo) {
    lines.push(t('knowledgeTags.preview.undo', { action: historyActionLabel(preview.undo.action),
      tags: preview.undo.restores.map(tag => tag.name).join('、') }))
  }
  return lines
}

const HISTORY_ACTIONS = new Set(['create', 'add_alias', 'propose_alias', 'confirm_alias', 'revive', 'approve', 'merge',
  'merge_in', 'split', 'split_from', 'retire', 'remove_alias', 'relate', 'unrelate', 'relation_moved', 'undo'])

/** A revision's action in words; an action this page does not know yet shows as stored. */
export function historyActionLabel(action: string) {
  return HISTORY_ACTIONS.has(action) ? t(`knowledgeTags.history.${action}`) : action
}

/** The Provider's refusal code from a console error body ({ error, code }), if it gave one. */
export function refusalCode(detail: string): string {
  try {
    const code = (JSON.parse(detail) as { code?: unknown })?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

/** A change an Agent's link asks for: /tags?tag=<id>&change=<change>[&into=<id>]. */
export function linkedChange(query: Record<string, unknown>): { tagId: string; change: GovernanceChange | null; intoId: string } | null {
  const tagId = typeof query.tag === 'string' ? query.tag : ''
  if (!tagId) return null
  const change = typeof query.change === 'string' && LINKABLE.has(query.change as GovernanceChange)
    ? query.change as GovernanceChange : null
  return { tagId, change, intoId: typeof query.into === 'string' ? query.into : '' }
}

const LINKABLE = new Set<GovernanceChange>(['approve', 'merge', 'split', 'retire', 'undo', 'revive'])

import { t } from '@/i18n'
import type { KnowledgeItemSummary, ScopeProject } from '@/features/knowledge-quick-edit/model'
import { projectLabel, type SessionProject, type SessionRecordsView } from '@/features/session-records/model'

// rec#20 part 2: what one host session held in its temporary project because
// nobody chose a scope, offered for a move into the formal project the session
// linked to. The person chooses the items; nothing moves without them.

/** One page of the held items, oldest first; next_offset is where the next page starts. */
export interface SessionMigrationPreview {
  temporary_project_id: string
  target_project: ScopeProject
  held_count: number
  linked_task_count: number
  items: KnowledgeItemSummary[]
  next_offset?: number | null
}

/** One move takes at most this many items (the Provider's limit); what can be chosen is not limited. */
export const MAX_MOVE = 100

/** The pages read so far as one list; the last page says where the next one starts. */
export function appendPage(loaded: SessionMigrationPreview | null, page: SessionMigrationPreview): SessionMigrationPreview {
  if (!loaded) return page
  const seen = new Set(loaded.items.map(itemKey))
  return { ...page, items: [...loaded.items, ...page.items.filter(item => !seen.has(itemKey(item)))] }
}

/** Codes and items of a refused move, from the console's 409 body. */
export function migrationRefusal(detail: string): { code: string; items: Array<{ item_kind: string; item_id: string }> } {
  try {
    const body = JSON.parse(detail)
    return { code: String(body?.code ?? ''), items: Array.isArray(body?.items) ? body.items : [] }
  } catch {
    return { code: '', items: [] }
  }
}

export interface SessionMigrationResult {
  target_project_id: string
  moved: Array<{ item_kind: KnowledgeItemSummary['item_kind']; item_id: string }>
}

export interface MigrationTarget { spaceId: string; sessionId: string; client: string; projectId: string }

export const itemKey = (item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) => `${item.item_kind}:${item.item_id}`


export function defaultReason(preview: SessionMigrationPreview) {
  return t('sessionMigration.defaultReason', { project: projectLabel(preview.target_project) })
}

// The body of POST /api/knowledge/session-migration: each chosen item with
// the version this page showed, or null while nothing is chosen, more than one
// move takes are chosen, or no reason is given.
export function migrationRequest(target: MigrationTarget, preview: SessionMigrationPreview, chosen: Set<string>,
  reason: string) {
  const items = preview.items.filter(item => chosen.has(itemKey(item)))
    .map(item => ({ itemKind: item.item_kind, itemId: item.item_id, expectedVersion: item.version }))
  if (!items.length || items.length > MAX_MOVE || !reason.trim()) return null
  return { personalSpaceId: target.spaceId, sourceApplication: target.client, sessionId: target.sessionId,
    projectId: target.projectId, reason: reason.trim(), items }
}

/**
 * The choice after a read. The first page of the first read starts chosen:
 * moving the batch is the default, and any item can be left out. Anything
 * shown later (a further page, an item newly held) starts unchosen, and an
 * item already shown keeps the person's choice. Of what the person had chosen,
 * items that changed since are marked to look at again, and items no longer
 * held (placed elsewhere, edited into a new version or deleted) leave the list.
 */
export function reconcileChoice(before: SessionMigrationPreview | null, after: SessionMigrationPreview,
  chosen: Set<string>) {
  const seen = new Map((before?.items ?? []).map(item => [itemKey(item), item]))
  const next = new Set<string>()
  const changed = new Set<string>()
  for (const item of after.items) {
    const key = itemKey(item)
    const shown = seen.get(key)
    if (!before || chosen.has(key)) next.add(key)
    if (shown && chosen.has(key) && shown.version !== item.version) changed.add(key)
  }
  const now = new Set(after.items.map(itemKey))
  const gone = [...chosen].filter(key => seen.has(key) && !now.has(key)).length
  return { chosen: next, changed, gone }
}

export function migrationPath(sessionId: string, client: string, projectId: string) {
  return `/s/${encodeURIComponent(sessionId)}/migrate?${new URLSearchParams({ client, project: projectId })}`
}

/**
 * On a session's record list: while the session still holds undecided items
 * in its temporary project, one offer per formal project its turns worked in,
 * newest first. The page the offer opens reads what is held again.
 */
export function sessionMigrationOffers(view: SessionRecordsView | null) {
  const client = view?.session.sourceApplication
  if (!view || !client) return []
  if (!view.entries.some(entry => entry.detail.item?.scope.kind === 'temporary')) return []
  const projects = new Map<string, SessionProject>()
  for (const entry of [...view.entries].reverse()) {
    if (entry.kind === 'turn' && entry.project && !entry.project.temporary) projects.set(entry.project.id, entry.project)
  }
  return [...projects.values()].map(project => ({ project,
    path: migrationPath(view.session.sessionId, client, project.id) }))
}

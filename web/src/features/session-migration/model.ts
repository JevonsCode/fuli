import { t } from '@/i18n'
import type { KnowledgeItemSummary, ScopeProject } from '@/features/knowledge-quick-edit/model'
import { projectLabel, type SessionProject, type SessionRecordsView } from '@/features/session-records/model'

// rec#20 part 2: what one host session held in its temporary project because
// nobody chose a scope, offered for a move into the formal project the session
// linked to. The person chooses the items; nothing moves without them.

export interface SessionMigrationPreview {
  temporary_project_id: string
  target_project: ScopeProject
  held_count: number
  linked_task_count: number
  truncated: boolean
  items: KnowledgeItemSummary[]
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
// the version this page showed, or null while nothing is chosen or no reason.
export function migrationRequest(target: MigrationTarget, preview: SessionMigrationPreview, chosen: Set<string>,
  reason: string) {
  const items = preview.items.filter(item => chosen.has(itemKey(item)))
    .map(item => ({ itemKind: item.item_kind, itemId: item.item_id, expectedVersion: item.version }))
  if (!items.length || !reason.trim()) return null
  return { personalSpaceId: target.spaceId, sourceApplication: target.client, sessionId: target.sessionId,
    projectId: target.projectId, reason: reason.trim(), items }
}

/**
 * The choice after a (re-)read. An item seen for the first time starts chosen:
 * moving the whole batch is the default, and any item can be left out. An item
 * already shown keeps the person's choice. Of what the person had chosen,
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
    if (!shown || chosen.has(key)) next.add(key)
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

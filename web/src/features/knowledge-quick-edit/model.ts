import { ApiError } from '@/api/client'
import { t } from '@/i18n'
import { knowledgePath } from '@/router/paths'
import type { KnowledgeVersionStatus } from '@/types'

// rec#20: one knowledge item exactly as the Provider read it back, opened from
// a turn receipt's link. Payload types and the labels and requests built from
// them; the pages only compose.

export type ItemKind = 'entity' | 'relationship'
export type ItemCategory = 'taste' | 'judgment' | 'personality' | 'rule' | 'experience' | 'fact' | 'knowledge'
export type ConfirmationStatus = 'pending' | 'agent_confirmed' | 'confirmed'
export type ContentSource = 'user_explicit' | 'agent_inferred'
export type VersionStatus = KnowledgeVersionStatus
/** A basis can also be gone: a person permanently deleted it (rec#5 C9). */
export type BasisStatus = VersionStatus | 'deleted'
export type ChangedBy = 'user' | 'agent'

export interface ScopeProject { id: string; name?: string | null; temporary?: boolean }

export interface ItemScope {
  kind: 'global' | 'projects' | 'agent' | 'temporary' | 'unknown'
  projects: ScopeProject[]
  agent_id?: string | null
  agent_name?: string | null
  status: 'set' | 'undetermined'
}

export interface ItemWeight {
  percent: number
  basis: { confirmation_status: ConfirmationStatus; confirmed_by_person: boolean; qualified_use_count: number;
    distinct_task_count: number; source_count: number; negative_evidence_count: number }
}

/** project_id: the project whose vocabulary holds a project tag. */
export interface ItemTag { id: string; name: string; namespace: string; status: string; project_id?: string | null }

export interface KnowledgeItemSummary {
  item_kind: ItemKind
  item_id: string
  version: number
  title: string
  content: string
  type: string
  profile_aspect?: string | null
  category: ItemCategory
  scope: ItemScope
  weight?: ItemWeight | null
  tags: ItemTag[]
  confirmation_status: ConfirmationStatus
  content_source?: ContentSource | null
  invalid_at?: string | null
  created_at?: string | null
  status?: VersionStatus
}

export interface EvidenceSource {
  episode_id: string
  source_kind?: string | null
  source_application?: string | null
  session_id?: string | null
  conversation_id?: string | null
  excerpt?: string | null
  created_at?: string | null
}

export interface ItemRevision { id: string; action: string; reason: string; created_at: string; changed_by?: ChangedBy | null }

/** One version of an item: its own words, who wrote it and why, and where it stands. */
export interface ItemVersion {
  item_kind: ItemKind
  item_id: string
  content: string
  status: VersionStatus
  confirmation_status: ConfirmationStatus
  content_source?: ContentSource | null
  changed_by?: ChangedBy | null
  reason?: string | null
  created_at?: string | null
  invalid_at?: string | null
  /** Bases out of date when this version re-asserted its words, which it no longer rests on. */
  released_bases?: string[]
}

/** Knowledge this item was concluded from (C8-4). */
export interface ItemBasis { item_kind: ItemKind; item_id: string; content: string; status: BasisStatus }

export interface KnowledgeItemView extends KnowledgeItemSummary {
  evidence: EvidenceSource[]
  evidence_count: number
  /** Deleted source markers contain no source text and remain only until human review. */
  unavailable_sources?: { episode_id: string; deletion_id: string; status: 'unavailable' }[]
  revisions: ItemRevision[]
  versions?: ItemVersion[]
  current_item_id?: string | null
  bases?: ItemBasis[]
  /** D-20.7: a basis changed its meaning (waits for a person) or only its wording (a hint). */
  basis_review?: BasisReview | null
  /** How many current conclusions rest on this item's versions. */
  dependent_count?: number
}

export type BasisReview = 'changed' | 'reworded'
/** What a person says an edit of a basis means for the conclusions drawn from it. */
export type BasisMeaning = 'changed' | 'wording_only'

/** What a PATCH answers: an edit names the new version it wrote. */
export interface RevisionResult {
  version_item_id?: string | null
  dependents_outdated?: number
  dependents_changed?: number
  outcome?: 'applied' | 'pending_person'
}

export interface TurnReceiptEntry extends KnowledgeItemSummary { change: 'created' | 'updated' }
/** deleted_count: how many permanent deletes removed something this turn saved (rec#5 C9). */
export interface TurnReceipt { entries: TurnReceiptEntry[]; unchanged_count: number; deleted_count?: number }

export type ScopeChoice = 'global' | 'projects' | 'agent'

export interface ScopeDraft { choice: ScopeChoice; projectIds: string[]; agentProjectId: string; agentId: string }

export const isPreference = (item: KnowledgeItemSummary) => Boolean(item.profile_aspect)

export function itemEditPath(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) {
  return `/knowledge/item/${encodeURIComponent(spaceId)}/${item.item_kind}/${encodeURIComponent(item.item_id)}`
}

/**
 * The item in the knowledge workspace, in its first project when it has one:
 * where 加入项目 resolves a project that already holds the same or a
 * conflicting item (rec#11 D-22.2).
 */
export function knowledgeWorkspaceItemPath(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id' | 'scope'>) {
  const project = item.scope.projects.find(candidate => !candidate.temporary)
  return knowledgePath('personal', spaceId, 'directory', { projectId: project?.id ?? null,
    itemKind: item.item_kind, itemId: item.item_id })
}

export function categoryLabel(item: KnowledgeItemSummary) {
  return t(`knowledgeQuickEdit.category.${item.category}`)
}

export function sourceLabel(item: Pick<KnowledgeItemSummary, 'content_source'>) {
  return t(`knowledgeQuickEdit.source.${item.content_source ?? 'unknown'}`)
}

export function confirmationLabel(item: Pick<KnowledgeItemSummary, 'confirmation_status'>) {
  return t(`knowledgeQuickEdit.confirmation.${item.confirmation_status}`)
}

export const versionStatus = (item: Pick<KnowledgeItemSummary, 'status' | 'invalid_at'>): VersionStatus =>
  item.status ?? (item.invalid_at ? 'inactive' : 'current')

export function versionStatusLabel(status: BasisStatus) {
  return t(`knowledgeQuickEdit.status.${status}`)
}

/** The badge tone of a version: current in use, out of date a warning, the rest quiet history. */
export function versionTone(status: BasisStatus): 'success' | 'warning' | 'secondary' | 'outline' {
  if (status === 'current') return 'success'
  if (status === 'outdated' || status === 'basis_outdated' || status === 'deleted') return 'warning'
  return status === 'superseded' ? 'secondary' : 'outline'
}

// An edit's own evidence says who edited it and where, not the stored enum.
const EDIT_SOURCE_KINDS = new Set(['human_knowledge_edit', 'agent_knowledge_edit'])

export function evidenceKindLabel(source: Pick<EvidenceSource, 'source_kind'>) {
  if (source.source_kind && EDIT_SOURCE_KINDS.has(source.source_kind)) {
    return t(`knowledgeQuickEdit.history.kinds.${source.source_kind}`)
  }
  return source.source_kind || '—'
}

export function evidenceApplicationLabel(source: Pick<EvidenceSource, 'source_kind' | 'source_application'>) {
  if (source.source_application) return source.source_application
  return source.source_kind === 'human_knowledge_edit' ? t('knowledgeQuickEdit.history.console') : '—'
}

export function changedByLabel(changedBy?: ChangedBy | null) {
  return t(`knowledgeQuickEdit.history.by.${changedBy ?? 'unknown'}`)
}

// A version that went out of date and has no newer one can be said again;
// that writes a new version and keeps the time it was not valid (C8-3).
export function canReassert(item: KnowledgeItemView) {
  return ['outdated', 'basis_outdated'].includes(versionStatus(item)) && !item.current_item_id
}

/** The ?item= id of a version's quick look on the item page. */
export const versionPeekId = (version: Pick<ItemVersion, 'item_kind' | 'item_id'>) => `${version.item_kind}:${version.item_id}`

export function versionFromPeekId(value: string): Pick<ItemVersion, 'item_kind' | 'item_id'> | null {
  const [kind, ...rest] = value.split(':')
  const id = rest.join(':')
  return (kind === 'entity' || kind === 'relationship') && id ? { item_kind: kind, item_id: id } : null
}

const projectName = (project: ScopeProject) => project.name || project.id

// The scope it applies to now; undecided is a separate mark, never a content status.
export function scopeLabel(scope: ItemScope) {
  const names = scope.projects.map(projectName).join('、')
  switch (scope.kind) {
    case 'global': return t('knowledgeQuickEdit.scope.global')
    case 'projects': return t('knowledgeQuickEdit.scope.projects', { names })
    case 'agent': return t('knowledgeQuickEdit.scope.agent', { agent: scope.agent_name || scope.agent_id || '', project: names })
    case 'temporary': return t('knowledgeQuickEdit.scope.temporary')
    default: return t('knowledgeQuickEdit.scope.unknown')
  }
}

// What the weight was computed from, so its number is never a bare claim.
export function weightBasisLabel(weight: ItemWeight) {
  if (weight.basis.confirmed_by_person) return t('knowledgeQuickEdit.weight.person')
  const basis = t('knowledgeQuickEdit.weight.basis', { uses: weight.basis.qualified_use_count,
    tasks: weight.basis.distinct_task_count, sources: weight.basis.source_count })
  return weight.basis.negative_evidence_count
    ? basis + t('knowledgeQuickEdit.weight.negative', { count: weight.basis.negative_evidence_count })
    : basis
}

// The form starts from where the item applies now; temporary or unknown
// starts from a project choice, because something has to be chosen.
export function initialScopeDraft(item: KnowledgeItemSummary): ScopeDraft {
  const projectIds = item.scope.projects.filter(project => !project.temporary).map(project => project.id)
  if (item.scope.kind === 'global') return { choice: 'global', projectIds: [], agentProjectId: '', agentId: '' }
  if (item.scope.kind === 'agent') {
    return { choice: 'agent', projectIds, agentProjectId: projectIds[0] ?? '', agentId: item.scope.agent_id ?? '' }
  }
  return { choice: 'projects', projectIds, agentProjectId: projectIds[0] ?? '', agentId: '' }
}

// rec#20 part 2: facts, experiences and other knowledge apply to one or more
// projects; global and one FLA stay a personal preference's scope.
export function scopeChoices(item: KnowledgeItemSummary): ScopeChoice[] {
  return isPreference(item) ? ['global', 'projects', 'agent'] : ['projects']
}

// The body of POST /api/knowledge/:kind/:id/scope, or null while incomplete.
export function scopeRequest(spaceId: string, item: KnowledgeItemSummary, draft: ScopeDraft, reason: string) {
  const base = { personalSpaceId: spaceId, expectedVersion: item.version, reason: reason.trim(), scope: draft.choice }
  if (!base.reason) return null
  if (draft.choice === 'global') return { ...base, projectIds: [] }
  if (draft.choice === 'agent') {
    return draft.agentProjectId && draft.agentId ? { ...base, projectIds: [draft.agentProjectId], agentId: draft.agentId } : null
  }
  return draft.projectIds.length ? { ...base, projectIds: draft.projectIds } : null
}

// The body of PATCH /api/knowledge/:kind/:id for a content edit: it writes a
// new version that supersedes this one (C7), or re-asserts an outdated one (C8-3).
export function contentRequest(spaceId: string, item: KnowledgeItemSummary, content: string, reason: string,
  basisMeaning?: BasisMeaning | null) {
  const text = content.trim()
  if (!text || !reason.trim()) return null
  const fields = item.item_kind === 'entity' ? { name: text.slice(0, 512), summary: text } : { fact: text }
  return { personalSpaceId: spaceId, action: 'update', reason: reason.trim(), expectedVersion: item.version, ...fields,
    ...(basisMeaning ? { basisMeaning } : {}) }
}

// A person's review of a conclusion whose basis changed: it still holds (D-20.7).
export function reaffirmRequest(spaceId: string, item: KnowledgeItemSummary, reason: string) {
  return reason.trim()
    ? { personalSpaceId: spaceId, action: 'reaffirm', reason: reason.trim(), expectedVersion: item.version }
    : null
}

// A person says later that an edit of this basis did change what conclusions mean.
export function meaningChangedRequest(spaceId: string, item: KnowledgeItemSummary, reason: string) {
  return reason.trim()
    ? { personalSpaceId: spaceId, action: 'mark_meaning_changed', reason: reason.trim(), expectedVersion: item.version }
    : null
}

export function basisReviewLabel(review: BasisReview) {
  return t(`knowledgeQuickEdit.basisReview.${review}`)
}

// Marking outdated is the person's negative feedback and the end of the
// item's validity; its words and history stay (C8).
export function markOutdatedRequest(spaceId: string, item: KnowledgeItemSummary, reason: string) {
  return reason.trim()
    ? { personalSpaceId: spaceId, action: 'mark_outdated', reason: reason.trim(), expectedVersion: item.version }
    : null
}

// The tag routes take the scope a tag change is made from: a project tag's own
// project (only it can see the tag), otherwise one of the item's projects, or
// none for global knowledge.
export function tagProjectId(item: KnowledgeItemSummary, tag?: Partial<Pick<ItemTag, 'namespace' | 'project_id'>>) {
  if (tag?.namespace === 'project' && tag.project_id) return tag.project_id
  return item.scope.kind === 'global' ? null : item.scope.projects[0]?.id ?? null
}

/** project_match: a project to add already holds the same or a conflicting item; 加入项目 decides. */
export type EditFailure = 'conflict' | 'widening' | 'project_match' | 'superseded' | 'forbidden' | 'other'

export function editFailure(error: unknown): EditFailure {
  if (!(error instanceof ApiError)) return 'other'
  if (error.status === 401 || error.status === 403) return 'forbidden'
  if (error.status !== 409) return 'other'
  let code = ''
  try { code = JSON.parse(error.detail)?.code ?? '' } catch { code = '' }
  if (code === 'widening_requires_review') return 'widening'
  if (code === 'project_has_match') return 'project_match'
  return code === 'superseded' || code === 'reassert_as_new_version' ? 'superseded' : 'conflict'
}

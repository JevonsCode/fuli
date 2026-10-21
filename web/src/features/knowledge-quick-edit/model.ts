import { ApiError } from '@/api/client'
import { t } from '@/i18n'

// rec#20: one knowledge item exactly as the Provider read it back, opened from
// a turn receipt's link. Payload types and the labels and requests built from
// them; the pages only compose.

export type ItemKind = 'entity' | 'relationship'
export type ItemCategory = 'taste' | 'judgment' | 'personality' | 'rule' | 'experience' | 'fact' | 'knowledge'
export type ConfirmationStatus = 'pending' | 'agent_confirmed' | 'confirmed'
export type ContentSource = 'user_explicit' | 'agent_inferred'

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

export interface ItemTag { id: string; name: string; namespace: string; status: string }

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
}

export interface EvidenceSource {
  episode_id: string
  source_kind?: string | null
  source_application?: string | null
  session_id?: string | null
  excerpt?: string | null
  created_at?: string | null
}

export interface ItemRevision { id: string; action: string; reason: string; created_at: string }

export interface KnowledgeItemView extends KnowledgeItemSummary {
  evidence: EvidenceSource[]
  evidence_count: number
  revisions: ItemRevision[]
}

export interface TurnReceiptEntry extends KnowledgeItemSummary { change: 'created' | 'updated' }
export interface TurnReceipt { entries: TurnReceiptEntry[]; unchanged_count: number }

export type ScopeChoice = 'global' | 'projects' | 'agent'

export interface ScopeDraft { choice: ScopeChoice; projectIds: string[]; agentProjectId: string; agentId: string }

export const isPreference = (item: KnowledgeItemSummary) => Boolean(item.profile_aspect)

export function itemEditPath(spaceId: string, item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'>) {
  return `/knowledge/item/${encodeURIComponent(spaceId)}/${item.item_kind}/${encodeURIComponent(item.item_id)}`
}

export function categoryLabel(item: KnowledgeItemSummary) {
  return t(`knowledgeQuickEdit.category.${item.category}`)
}

export function sourceLabel(item: KnowledgeItemSummary) {
  return t(`knowledgeQuickEdit.source.${item.content_source ?? 'unknown'}`)
}

export function confirmationLabel(item: KnowledgeItemSummary) {
  return t(`knowledgeQuickEdit.confirmation.${item.confirmation_status}`)
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
  const projectIds = isPreference(item) ? draft.projectIds : draft.projectIds.slice(0, 1)
  return projectIds.length ? { ...base, projectIds } : null
}

// The body of PATCH /api/knowledge/:kind/:id for a content edit.
export function contentRequest(spaceId: string, item: KnowledgeItemSummary, content: string, reason: string) {
  const text = content.trim()
  if (!text || !reason.trim()) return null
  const fields = item.item_kind === 'entity' ? { name: text.slice(0, 512), summary: text } : { fact: text }
  return { personalSpaceId: spaceId, action: 'update', reason: reason.trim(), expectedVersion: item.version, ...fields }
}

export function deactivateRequest(spaceId: string, item: KnowledgeItemSummary, reason: string) {
  return reason.trim()
    ? { personalSpaceId: spaceId, action: 'invalidate', reason: reason.trim(), expectedVersion: item.version }
    : null
}

// The tag routes take a project the item belongs to, or none for global knowledge.
export function tagProjectId(item: KnowledgeItemSummary) {
  return item.scope.kind === 'global' ? null : item.scope.projects[0]?.id ?? null
}

export type EditFailure = 'conflict' | 'widening' | 'forbidden' | 'other'

export function editFailure(error: unknown): EditFailure {
  if (!(error instanceof ApiError)) return 'other'
  if (error.status === 401 || error.status === 403) return 'forbidden'
  if (error.status !== 409) return 'other'
  let code = ''
  try { code = JSON.parse(error.detail)?.code ?? '' } catch { code = '' }
  return code === 'widening_requires_review' ? 'widening' : 'conflict'
}

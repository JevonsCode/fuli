import type { CountEvidence, HistoryProject, ProjectEvidence } from './evidence-reader'

// Pure preview rules. A suggestion is advice for a human; nothing here acts on it.
export type ProjectOrigin = 'conversation_fallback' | 'temporary_task' | 'registered_with_sources' | 'unknown'
export type PreviewSuggestion =
  | 'keep' | 'review_assignment' | 'merge_review' | 'archive_candidate'
  | 'review_manually' | 'insufficient_evidence'

export interface ProjectPreview {
  evidence: ProjectEvidence
  origin: ProjectOrigin
  suggestion: PreviewSuggestion
  complete: boolean
  hasHistory: boolean
  mergeWith: string[]
  sameNameCount: number
}

export interface HistoryPreview {
  projects: ProjectPreview[]
  complete: boolean
  incompleteCount: number
  counts: Partial<Record<PreviewSuggestion, number>>
}

// The identity task entry generates for an unmatched session; the display
// name is shared by every such project and is not used as evidence.
const CONVERSATION_FALLBACK_ID = /^conversation-[0-9a-f]{64}$/

export function projectOrigin(project: HistoryProject): ProjectOrigin {
  if (project.scope_type === 'temporary') return 'temporary_task'
  if (CONVERSATION_FALLBACK_ID.test(project.project_id)) return 'conversation_fallback'
  if (sourceKeys(project).length) return 'registered_with_sources'
  return 'unknown'
}

export function buildHistoryPreview(evidence: ProjectEvidence[]): HistoryPreview {
  const bySource = new Map<string, Set<string>>()
  const byName = new Map<string, number>()
  for (const { project } of evidence) {
    for (const key of sourceKeys(project)) {
      bySource.set(key, (bySource.get(key) ?? new Set()).add(project.project_id))
    }
    const name = nameKey(project)
    byName.set(name, (byName.get(name) ?? 0) + 1)
  }
  const projects = evidence.map((item): ProjectPreview => {
    const { project } = item
    const origin = projectOrigin(project)
    const complete = [item.knowledge, item.tasks, item.assignments].every(isComplete)
    const hasHistory = item.knowledge.count > 0 || item.tasks.count > 0 || item.assignments.count > 0
      || item.knowledge.relations > 0 || item.knowledge.referencedElsewhere > 0
    const mergeWith = isFallback(origin) ? [] : [...new Set(sourceKeys(project)
      .flatMap(key => [...(bySource.get(key) ?? [])]))].filter(id => id !== project.project_id)
    return {
      evidence: item, origin, complete, hasHistory, mergeWith,
      sameNameCount: (byName.get(nameKey(project)) ?? 1) - 1,
      suggestion: suggestionFor(origin, complete, hasHistory, mergeWith.length > 0),
    }
  })
  const counts: HistoryPreview['counts'] = {}
  for (const { suggestion } of projects) counts[suggestion] = (counts[suggestion] ?? 0) + 1
  const incompleteCount = projects.filter(({ complete }) => !complete).length
  return { projects, complete: incompleteCount === 0, incompleteCount, counts }
}

function suggestionFor(origin: ProjectOrigin, complete: boolean, hasHistory: boolean, sharesSource: boolean): PreviewSuggestion {
  if (sharesSource) return 'merge_review'
  // Partial evidence can prove history exists, but never that a project is empty.
  if (hasHistory) return origin === 'conversation_fallback' ? 'review_assignment' : 'keep'
  if (!complete) return 'insufficient_evidence'
  return isFallback(origin) ? 'archive_candidate' : 'review_manually'
}

function isFallback(origin: ProjectOrigin) {
  return origin === 'conversation_fallback' || origin === 'temporary_task'
}

function isComplete({ status }: CountEvidence) {
  return status === 'complete'
}

function nameKey(project: HistoryProject) {
  return String(project.profile?.name ?? '').trim().toLowerCase()
}

// A recorded source location; only a trailing slash or .git suffix is ignored.
function sourceKeys(project: HistoryProject): string[] {
  return (project.profile?.sources ?? []).flatMap((source) => {
    const uri = typeof source?.uri === 'string' ? source.uri.trim() : ''
    return uri ? [uri.replace(/\/+$/, '').replace(/\.git$/, '')] : []
  })
}

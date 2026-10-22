import { getJson, postJson } from '@/api/client'
import type { GovernancePreview, GovernanceRequest, StatusFilter, TagDetail, TagEntry, TagNamespace, TagVocabulary } from './model'

// The console's tag vocabulary routes (rec#11 D-07 part 2). Reads cover every
// project, as the owner sees them. A governance preview is a read; applying it
// names the preview's digest and is accepted only from this computer, sent on
// the human-review channel. The person's own alias goes the same way.

export const VOCABULARY_PAGE = 100

export function readVocabulary(spaceId: string, filters: { query?: string; namespace?: TagNamespace | ''; status?: StatusFilter;
  offset?: number }) {
  const query = new URLSearchParams({ personalSpaceId: spaceId, limit: String(VOCABULARY_PAGE) })
  if (filters.query?.trim()) query.set('q', filters.query.trim())
  if (filters.namespace) query.set('namespace', filters.namespace)
  if (filters.status) query.set('status', filters.status)
  if (filters.offset) query.set('offset', String(filters.offset))
  return getJson<TagVocabulary>(`/api/knowledge-tags/vocabulary?${query}`)
}

export function readTagDetail(spaceId: string, tagId: string) {
  return getJson<TagDetail>(`/api/knowledge-tags/detail?${new URLSearchParams({ personalSpaceId: spaceId, tagId })}`)
}

export function previewGovernance(spaceId: string, request: GovernanceRequest) {
  return postJson<GovernancePreview>('/api/knowledge-tags/governance/preview', { personalSpaceId: spaceId, ...request })
}

export function applyGovernance(spaceId: string, request: GovernanceRequest, preview: GovernancePreview, reason: string) {
  return postJson<{ operation_id: string }>('/api/knowledge-tags/governance', { personalSpaceId: spaceId, ...request,
    previewDigest: preview.digest, reason })
}

// The person adding an Agent's alias accepts it; a project tag is changed from its own project.
export function acceptAlias(spaceId: string, tag: Pick<TagEntry, 'id' | 'project_id'>, alias: string, reason: string) {
  return postJson<unknown>('/api/knowledge-tags', { action: 'add_alias', personalSpaceId: spaceId,
    personalProjectId: tag.project_id, tagId: tag.id, alias, reason })
}

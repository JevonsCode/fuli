import { putJson } from '@/api/client'
import type { PersonalProject } from '@/types'

export interface NewProjectDraft {
  name: string
  purpose: string
  includes: string
  excludes: string
  source: string
}

/** A readable project ID from the name, not colliding with any known project. */
export function newProjectId(name: string, existingIds: Iterable<string>) {
  const base = name.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'project'
  const taken = new Set(existingIds)
  if (!taken.has(base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

function lines(value: string) {
  return [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))].slice(0, 64)
}

/** Create only: the Provider refuses (409) instead of replacing a project with the same ID. */
export function createPersonalProject(personalSpaceId: string, projectId: string, draft: NewProjectDraft) {
  const source = draft.source.trim()
  return putJson<PersonalProject>('/api/personal-projects', {
    personalSpaceId,
    projectId,
    createOnly: true,
    profile: {
      name: draft.name.trim(),
      purpose: draft.purpose.trim() || null,
      scope: draft.includes.trim() || null,
      lifecycle: 'active',
      boundaries: lines(draft.excludes),
      sources: source ? [{ key: 'source-1', kind: 'other', title: source, uri: source, sensitivity: 'normal' }] : [],
    },
  })
}

import type { PersonalProject } from '@/types'
import { type ProjectNaming, temporaryProjectName } from './temporary-project-name'

// The identity task entry generated for an unmatched session until 2026-10-18.
const CONVERSATION_FALLBACK_ID = /^conversation-[0-9a-f]{64}$/

/** Last use as a number; a missing or unreadable time sorts as oldest, never NaN. */
function lastUsed(project: ProjectNaming) {
  return Date.parse(project.updated_at ?? project.created_at ?? '') || 0
}

export function isConversationFallback(project: Pick<PersonalProject, 'project_id'>) {
  return CONVERSATION_FALLBACK_ID.test(project.project_id)
}

export function isArchivedProject(project: Pick<PersonalProject, 'status' | 'profile'>) {
  return project.status === 'archived' || project.profile?.lifecycle === 'archived'
}

export function isFormalProject(project: Pick<PersonalProject, 'project_id' | 'scope_type' | 'status' | 'profile'>) {
  if (isArchivedProject(project)) return false
  return !hasTemporaryOrigin(project)
}

/** Started temporary, archived or not: marked temporary, or a session fallback (its generated ID or recorded origin). */
export function hasTemporaryOrigin(project: ProjectNaming) {
  return isConversationFallback(project) || project.scope_type === 'temporary' || project.profile?.origin === 'conversation_fallback'
}

/** Most recently used first; equal or unknown times fall back to ID order, the same way every time. */
export function byLastUse(a: ProjectNaming, b: ProjectNaming) {
  return lastUsed(b) - lastUsed(a) || a.project_id.localeCompare(b.project_id)
}

/**
 * A name people can tell apart, in the console's own language. A project
 * somebody named keeps their name. A temporary project has none stored, so it
 * is named here: FULI's words for it, its short number and its last-use date.
 */
export function projectDisplayName(project: ProjectNaming, number?: string) {
  if (!hasTemporaryOrigin(project)) return project.profile?.name ?? ''
  return temporaryProjectName(project, number)
}

/** Projects a person set up first, in their given order; temporary ones after, newest first. */
export function pickerOrder<T extends PersonalProject>(projects: readonly T[]): T[] {
  const formal = projects.filter(project => !hasTemporaryOrigin(project))
  const temporary = projects.filter(hasTemporaryOrigin).sort(byLastUse)
  return [...formal, ...temporary]
}

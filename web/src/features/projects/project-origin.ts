import { currentLocale, t } from '@/i18n'
import type { PersonalProject } from '@/types'

// The identity task entry generates for an unmatched session. Every such
// project shares one display name, so the name is never used as evidence.
const CONVERSATION_FALLBACK_ID = /^conversation-[0-9a-f]{64}$/

/** Last use as a number; a missing or unreadable time sorts as oldest, never NaN. */
function lastUsed(project: PersonalProject) {
  return Date.parse(project.updated_at ?? project.created_at ?? '') || 0
}

export function isConversationFallback(project: Pick<PersonalProject, 'project_id'>) {
  return CONVERSATION_FALLBACK_ID.test(project.project_id)
}

export function isFormalProject(project: Pick<PersonalProject, 'project_id' | 'scope_type' | 'status' | 'profile'>) {
  if (isConversationFallback(project)) return false
  if (project.scope_type === 'temporary') return false
  if (project.status === 'archived' || project.profile?.lifecycle === 'archived') return false
  if (project.profile?.origin === 'conversation_fallback') return false
  return true
}

/** A name people can tell apart: fallback session projects show when they were last used. */
export function projectDisplayName(project: PersonalProject) {
  if (!isConversationFallback(project)) return project.profile.name
  const at = lastUsed(project)
  const time = !at ? '' : new Intl.DateTimeFormat(currentLocale(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(at)
  return time ? t('projects.conversationFallback', { time }) : t('projects.conversationFallbackUndated')
}

/** Projects a person set up first, in their given order; session fallbacks after, newest first. */
export function pickerOrder<T extends PersonalProject>(projects: readonly T[]): T[] {
  const formal = projects.filter(project => !isConversationFallback(project))
  const fallback = projects.filter(isConversationFallback)
    .sort((a, b) => lastUsed(b) - lastUsed(a) || a.project_id.localeCompare(b.project_id))
  return [...formal, ...fallback]
}

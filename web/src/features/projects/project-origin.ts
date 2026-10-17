import { currentLocale, t } from '@/i18n'
import type { PersonalProject } from '@/types'

// The identity task entry generates for an unmatched session. Every such
// project shares one display name, so the name is never used as evidence.
const CONVERSATION_FALLBACK_ID = /^conversation-[0-9a-f]{64}$/

export function isConversationFallback(project: Pick<PersonalProject, 'project_id'>) {
  return CONVERSATION_FALLBACK_ID.test(project.project_id)
}

/** A name people can tell apart: fallback session projects show when they were last used. */
export function projectDisplayName(project: PersonalProject) {
  if (!isConversationFallback(project)) return project.profile.name
  const at = Date.parse(project.updated_at ?? project.created_at ?? '')
  const time = Number.isNaN(at) ? '' : new Intl.DateTimeFormat(currentLocale(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(at)
  return time ? t('projects.conversationFallback', { time }) : t('projects.conversationFallbackUndated')
}

/** Projects a person set up first, in their given order; session fallbacks after, newest first. */
export function pickerOrder<T extends PersonalProject>(projects: readonly T[]): T[] {
  const formal = projects.filter(project => !isConversationFallback(project))
  const fallback = projects.filter(isConversationFallback)
    .sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '') || a.project_id.localeCompare(b.project_id))
  return [...formal, ...fallback]
}

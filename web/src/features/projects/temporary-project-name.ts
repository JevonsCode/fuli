import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import type { PersonalProject } from '@/types'

/**
 * What to call a temporary project. FULI stores no name for one
 * (graph-provider/fuli_graph/temporary_project_scope.py), so every console
 * writes the words itself, in its own language, and tells one project from
 * another by a short number taken from its ID plus the date it was last used.
 */

// The names FULI generated for a temporary project before graph/23 cleared
// them. A graph still waiting for that migration serves them, and they say
// nothing about which project it is, so they are never shown as a title.
const GENERATED_NAMES = new Set(['临时任务 / Temporary task', '临时会话 / Temporary session', '会话项目 / Conversation project'])
// A generated temporary project ID: its origin word and the hex digest its number is cut from.
const GENERATED_ID = /^(temporary|conversation)-([0-9a-f]{64})$/
// A number is at least this long, and only as much longer as it takes to tell it apart.
export const NUMBER_LENGTH = 8

/**
 * What naming a project needs, so that a caller holding a summary rather than a
 * whole record can name it too: its ID, where it came from, whatever name is
 * stored, and when it was last used.
 */
export interface ProjectNaming {
  project_id: string
  scope_type?: PersonalProject['scope_type']
  profile?: { name?: string | null } | null
  updated_at?: string | null
  created_at?: string | null
}

/** The title a person or an Agent gave this project, or '' where only FULI named it. */
export function givenProjectTitle(project: ProjectNaming) {
  const name = project.profile?.name?.trim() ?? ''
  return GENERATED_NAMES.has(name) ? '' : name
}

/**
 * What a temporary project's number is cut from: the digest of a generated ID,
 * or, for any other ID, a stable code of the whole ID — the FNV-1a 32-bit
 * hashes of it and of it reversed, 16 hex characters, so anyone can recompute
 * it from the full ID the row keeps in its title.
 */
export function temporaryNumberSource(projectId: string) {
  return GENERATED_ID.exec(projectId)?.[2] ?? fnv1a(projectId) + fnv1a([...projectId].reverse().join(''))
}

/** Which generation of temporary ID this is, for telling two equal digests apart. */
export function temporaryIdOrigin(projectId: string) {
  return GENERATED_ID.exec(projectId)?.[1]?.[0] ?? 'x'
}

/** An ID FULI generated for a temporary scope; a readable one a name made ('temporary-fix') is not. */
export const isGeneratedTemporaryId = (projectId: string) => GENERATED_ID.test(projectId)

// One project's number on its own, where there is no list to keep it unique within.
const temporaryProjectNumber = (projectId: string) => temporaryNumberSource(projectId).slice(0, NUMBER_LENGTH)

/**
 * A temporary project's name in the console's language: the title someone gave
 * it, or FULI's own words with the project's number and its last-use date.
 * `number` comes from a picker that keeps its numbers unique across the
 * projects it offers; without one the project's own number is used.
 */
export function temporaryProjectName(project: ProjectNaming, number = temporaryProjectNumber(project.project_id)) {
  const title = givenProjectTitle(project)
  if (title) return title
  const time = formatDateTime(project.updated_at ?? project.created_at, currentLocale(), DATE_ONLY, { missing: '', invalid: '' })
  return time ? t('projects.temporaryDated', { number, time }) : t('projects.temporary', { number })
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

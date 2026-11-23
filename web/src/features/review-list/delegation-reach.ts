import { hasTemporaryOrigin, isArchivedProject } from '@/features/projects/project-origin'
import type { PersonalProject } from '@/types'
import type { ReviewDelegation } from './review-api'

export type ReachNoticeKey = 'some' | 'someAndGeneral' | 'noProject' | 'nothing' | 'general'

/** Approved of total, for one kind of project. */
export interface ReachCount { approved: number; total: number }

export interface ReachNotice {
  key: ReachNoticeKey
  /** Projects people made, and temporary ones FULI opened by itself, counted apart (11-23). */
  formal: ReachCount
  temporary: ReachCount
}

/**
 * What the switch says instead of 「正在替你确认」 when Tonborg's model may not
 * read everything (rec issue 124): the projects it can confirm in, or none, and
 * whether knowledge outside projects waits for the person too. null when
 * nothing is out of its reach (or the read did not say).
 *
 * `temporaryIds`: the space's temporary projects, so that "1 of 288" reads as
 * the named and the temporary projects apart; most of a long list is
 * temporary, and lumping them in made it look like hundreds of real projects
 * were left out.
 */
export function reachNotice(reach: ReviewDelegation['reach'], temporaryIds: ReadonlySet<string> = new Set()): ReachNotice | null {
  if (!reach) return null
  const blocked = reach.blockedProjectIds.length
  const approved = reach.projects - blocked
  const general = !reach.unassignedAllowed
  const temporaryTotal = Math.min(temporaryIds.size, reach.projects)
  const temporaryBlocked = Math.min(reach.blockedProjectIds.filter(id => temporaryIds.has(id)).length, temporaryTotal)
  const formalTotal = reach.projects - temporaryTotal
  const notice = (key: ReachNoticeKey): ReachNotice => ({
    key,
    formal: { approved: Math.max(formalTotal - (blocked - temporaryBlocked), 0), total: formalTotal },
    temporary: { approved: temporaryTotal - temporaryBlocked, total: temporaryTotal },
  })
  if (!blocked) return general ? notice(reach.projects ? 'general' : 'nothing') : null
  if (!approved) return notice(general ? 'nothing' : 'noProject')
  return notice(general ? 'someAndGeneral' : 'some')
}

/**
 * The space's temporary projects as the server counts projects for `reach`:
 * archived ones are left out there (src/judgment/service.js activeProjectIds),
 * so they are here too, or the named and temporary counts would not add up.
 */
export function reachTemporaryIds(projects: readonly PersonalProject[], personalSpaceId: string): Set<string> {
  return new Set(projects.filter(project => project.personal_space_id === personalSpaceId
    && !isArchivedProject(project) && hasTemporaryOrigin(project)).map(project => project.project_id))
}

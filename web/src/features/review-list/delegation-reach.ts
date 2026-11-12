import type { ReviewDelegation } from './review-api'

export type ReachNoticeKey = 'some' | 'someAndGeneral' | 'noProject' | 'nothing' | 'general'

/**
 * What the switch says instead of 「正在替你确认」 when Tonborg's model may not
 * read everything (rec issue 124): the projects it can confirm in, or none, and
 * whether knowledge outside projects waits for the person too. null when
 * nothing is out of its reach (or the read did not say).
 */
export function reachNotice(reach: ReviewDelegation['reach']): { key: ReachNoticeKey; approved: number; total: number } | null {
  if (!reach) return null
  const blocked = reach.blockedProjectIds.length
  const approved = reach.projects - blocked
  const general = !reach.unassignedAllowed
  const notice = (key: ReachNoticeKey) => ({ key, approved, total: reach.projects })
  if (!blocked) return general ? notice(reach.projects ? 'general' : 'nothing') : null
  if (!approved) return notice(general ? 'nothing' : 'noProject')
  return notice(general ? 'someAndGeneral' : 'some')
}

import { z } from 'zod'
import { shapeFor } from '@/api/response-shape'
import { t } from '@/i18n'

// 「最近被问」: every contact visiting assistants from paired computers made
// with this computer's shared projects, a look at the lead's card or a search,
// answered or not (GET /api/visitor-access/reads, this computer only).

export type VisitorRead = {
  id: number
  requester: string
  agentName: string | null
  projectId: string
  action: 'search' | 'card'
  outcome: 'pending' | 'answered' | 'failed' | 'refused'
  code: string | null
  queries: string[]
  resultsCount: number
  at: string
}

export const RECENT_READS = 5

export const visitorReadsShape = shapeFor<{ reads: VisitorRead[] }>(z.looseObject({
  reads: z.array(z.looseObject({ id: z.number(), requester: z.string(), agentName: z.string().nullable(),
    projectId: z.string(), action: z.enum(['search', 'card']), outcome: z.enum(['pending', 'answered', 'failed', 'refused']),
    code: z.string().nullable(), queries: z.array(z.string()), resultsCount: z.number(), at: z.string() })),
}))

// Who asked: the computer, then its Agent when it named one.
export function readAsker(read: VisitorRead) {
  return read.agentName ? `${read.requester} · ${read.agentName}` : read.requester
}

// What was asked, in which shared project (its name when this computer still
// shares it): the searched words, or a look at who leads it, and when it got
// no answer, that it did not.
export function readQuestion(read: VisitorRead, projectNames: ReadonlyMap<string, string>) {
  // Never a raw id: a project this computer no longer shares (or none) gets a plain label.
  const project = projectNames.get(read.projectId) ?? t('settings.peer.readUnknownProject')
  if (read.code?.includes('rate_limited')) return t('settings.peer.readLimited', { project })
  if (read.outcome === 'refused' || read.outcome === 'failed') return t('settings.peer.readRefused', { project })
  if (read.action === 'card') return t('settings.peer.readCard', { project })
  return t('settings.peer.readAsked', { project, queries: read.queries.join(' / ') })
}

import { z } from 'zod'
import { shapeFor } from '@/api/response-shape'
import { t } from '@/i18n'

// 「最近被问」: what visiting assistants from paired computers read of this
// computer's shared projects (GET /api/visitor-access/reads, this computer only).

export type VisitorRead = {
  id: number
  requester: string
  agentName: string | null
  projectId: string
  queries: string[]
  resultsCount: number
  at: string
}

export const RECENT_READS = 5

export const visitorReadsShape = shapeFor<{ reads: VisitorRead[] }>(z.looseObject({
  reads: z.array(z.looseObject({ id: z.number(), requester: z.string(), agentName: z.string().nullable(),
    projectId: z.string(), queries: z.array(z.string()), resultsCount: z.number(), at: z.string() })),
}))

// Who asked: the computer, then its Agent when it named one.
export function readAsker(read: VisitorRead) {
  return read.agentName ? `${read.requester} · ${read.agentName}` : read.requester
}

// What was asked, in which shared project (its name when this computer still shares it).
export function readQuestion(read: VisitorRead, projectNames: ReadonlyMap<string, string>) {
  return t('settings.peer.readAsked', { project: projectNames.get(read.projectId) ?? read.projectId,
    queries: read.queries.join(' / ') })
}

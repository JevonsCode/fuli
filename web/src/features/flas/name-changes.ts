import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'
import type { AgentNameChange } from '@/types'

// The FLAs FULI renamed because another FLA of the space had the same name
// (graph/23), while the rename is recent: one list, each with its 原名, who
// kept the name and why this one gave it up. Shape follows
// src/graphiti/project-agent-mapping.js agentRenamed.
const renamedSchema = z.array(z.looseObject({
  agentId: z.string(),
  displayName: z.string(),
  status: z.string(),
  keptByName: z.string().nullish(),
  change: z.looseObject({ name: z.string(), until: z.string(), gaveWay: z.string().nullish() }),
}))

export interface AgentRenamed {
  agentId: string
  displayName: string
  status: string
  keptByName?: string | null
  change: Pick<AgentNameChange, 'name' | 'until'> & { gaveWay?: string | null }
}

export async function readNameChanges(personalSpaceId: string): Promise<AgentRenamed[]> {
  return getJson(`/api/project-agent-name-changes?${new URLSearchParams({ personalSpaceId })}`, shapeOf(renamedSchema))
}

const WHY = new Set(['built_in_role', 'dismissed', 'test', 'person_named', 'less_work', 'less_recent', 'later'])

/** Why this FLA gave its name up, in one short clause. */
export function gaveWayText(item: AgentRenamed): string {
  const rule = item.change.gaveWay && WHY.has(item.change.gaveWay) ? item.change.gaveWay : 'later'
  return t(`flas.renamed.why.${rule}`, { kept: item.keptByName ?? item.change.name })
}

const SEEN_KEY = 'fuli.flas.renamed.seen'

/** The newest rename the person already dismissed in this browser, if any. */
export function seenRename(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function markRenamesSeen(items: AgentRenamed[]) {
  const newest = items.map(item => item.change.until).sort().at(-1)
  if (!newest) return
  try {
    localStorage.setItem(SEEN_KEY, newest)
  } catch {
    // The notice comes back next time; nothing is lost.
  }
}

/** The whole list again once a rename is newer than the last one dismissed here; else nothing. */
export function unseenRenames(items: AgentRenamed[], seen: string): AgentRenamed[] {
  return items.some(item => item.change.until > seen) ? items : []
}

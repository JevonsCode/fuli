import { z } from 'zod'
import { getJson, putJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// Every rename in the space, newest first (src/graphiti/agent-name-workflows.js):
// a person's own, and each name the person settled for FLAs that shared it,
// with who kept it and why. seenUntil: up to when the person has seen the
// settled ones (知道了), kept with the space so every console agrees.
const changeSchema = z.looseObject({ name: z.string(), until: z.string(), reason: z.string(),
  gaveWay: z.string().nullish() })
const changesSchema = z.looseObject({
  seenUntil: z.string().nullable(),
  items: z.array(z.looseObject({ agentId: z.string(), displayName: z.string(), status: z.string(),
    keptByName: z.string().nullish(), change: changeSchema })),
})

export type NameChanges = z.infer<typeof changesSchema>
export type AgentRenamed = NameChanges['items'][number]

export function readNameChanges(personalSpaceId: string): Promise<NameChanges> {
  return getJson(`/api/project-agent-name-changes?${new URLSearchParams({ personalSpaceId })}`, shapeOf(changesSchema))
}

/** 知道了: the settled renames up to the newest one listed are seen. */
export function markNameChangesSeen(personalSpaceId: string, changes: NameChanges): Promise<NameChanges> {
  const until = settled(changes.items).map(item => item.change.until).sort().at(-1) ?? new Date().toISOString()
  return putJson('/api/project-agent-name-changes/seen', { personalSpaceId, until }, shapeOf(changesSchema))
}

/** The renames that settled a shared name, which the page announces once. */
export function settled(items: AgentRenamed[]): AgentRenamed[] {
  return items.filter(item => item.change.reason === 'duplicate_name')
}

/** The settled renames the person has not seen yet. */
export function unseenRenames(changes: NameChanges): AgentRenamed[] {
  const seen = changes.seenUntil ? Date.parse(changes.seenUntil) : -Infinity
  return settled(changes.items).filter(item => Date.parse(item.change.until) > seen)
}

const WHY = new Set(['built_in_role', 'dismissed', 'test', 'person_named', 'temporary_lead', 'less_work',
  'less_recent', 'later', 'person_chose'])

/** Why an FLA gave a shared name up, in one short clause; kept: who has the name now. */
export function gaveWayText(gaveWay: string | null | undefined, kept: string): string {
  return t(`flas.names.why.${gaveWay && WHY.has(gaveWay) ? gaveWay : 'later'}`, { kept })
}

/** What one rename was, in one short clause after the FLA's current name. */
export function changeText(item: AgentRenamed): string {
  const former = t('flas.names.former', { name: item.change.name })
  return item.change.reason === 'duplicate_name'
    ? `${former} · ${gaveWayText(item.change.gaveWay, item.keptByName ?? item.change.name)}`
    : `${former} · ${t('flas.names.renamedByPerson')}`
}

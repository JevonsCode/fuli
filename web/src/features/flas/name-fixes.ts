import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// The names FLAs of the space share and how each would be settled
// (src/graphiti/agent-name-workflows.js): who keeps it, what each other FLA
// becomes and why. Reading changes nothing; the person may pick another
// keeper (keep) or leave renames out, and one apply renames the rest.
const workingProjectSchema = z.looseObject({ projectId: z.string(), name: z.string(),
  scopeType: z.enum(['registered', 'temporary']) })
const memberSchema = z.looseObject({ agentId: z.string(), name: z.string(), status: z.string(),
  projects: z.array(workingProjectSchema), keeps: z.boolean(), newName: z.string().nullable(), gaveWay: z.string().nullable() })
const planSchema = z.looseObject({ renames: z.number(),
  groups: z.array(z.looseObject({ name: z.string(), members: z.array(memberSchema) })) })

export type NameFixPlan = z.infer<typeof planSchema>
export type NameFixMember = NameFixPlan['groups'][number]['members'][number]

export function readNameFixPlan(personalSpaceId: string, keep: string[] = []): Promise<NameFixPlan> {
  const query = new URLSearchParams({ personalSpaceId })
  for (const agentId of keep) query.append('keep', agentId)
  return getJson(`/api/project-agent-name-fixes?${query}`, shapeOf(planSchema))
}

/** Renames every FLA of the plan but those left out, to the names shown. */
export function applyNameFixes(personalSpaceId: string, plan: NameFixPlan, keep: string[], leftOut: Set<string>) {
  const renames = Object.fromEntries(plan.groups.flatMap(group => group.members)
    .filter(member => !member.keeps && member.newName && !leftOut.has(member.agentId))
    .map(member => [member.agentId, member.newName]))
  return postJson('/api/project-agent-name-fixes/apply', { personalSpaceId, keep, renames }, shapeOf(planSchema))
}

/** A keeper picked in one group replaces the earlier pick there. */
export function keepInstead(plan: NameFixPlan, keep: string[], agentId: string): string[] {
  const group = plan.groups.find(item => item.members.some(member => member.agentId === agentId))
  const others = new Set(group?.members.map(member => member.agentId) ?? [])
  return [...keep.filter(id => !others.has(id)), agentId]
}

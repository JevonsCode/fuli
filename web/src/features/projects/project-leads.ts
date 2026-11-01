import { readProjectTeam } from './project-team-api'

// Each project's lead, for the graph's project nodes: one /api/project-team
// read per project, shared by every graph drawn within a minute. A project
// without a lead, or whose read failed, has none.
const FRESH_MS = 60_000
const cache = new Map<string, { at: number; lead: Promise<string | null> }>()

export async function loadProjectLeads(personalSpaceId: string, projectIds: string[]): Promise<Map<string, string>> {
  const entries = await Promise.all([...new Set(projectIds)].map(async (projectId) => {
    const key = `${personalSpaceId}:${projectId}`
    const cached = cache.get(key)
    const entry = cached && Date.now() - cached.at < FRESH_MS ? cached : {
      at: Date.now(),
      lead: readProjectTeam(personalSpaceId, projectId).then(team => team.lead?.agentId ?? null, () => null),
    }
    cache.set(key, entry)
    return [projectId, await entry.lead] as const
  }))
  return new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])))
}

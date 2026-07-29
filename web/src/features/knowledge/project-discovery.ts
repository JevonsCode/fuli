import { getJson } from '@/api/client'
import type { PersonalProject } from '@/types'

const PROJECT_DISCOVERY_LIMIT = 15
const PROJECT_DISCOVERY_CONCURRENCY = 4

export interface KnowledgeSearchResult {
  entities?: Array<{ id: string; name: string; score?: number }>
  facts?: Array<{
    id: string
    source_entity: string
    target_entity: string
    score?: number
  }>
}

export interface PersonalProjectDiscoveryMatch {
  project: PersonalProject
  count: number
  score: number
}

export interface PersonalProjectDiscovery {
  matches: PersonalProjectDiscoveryMatch[]
  checked: number
  total: number
  failed: number
}

export async function discoverPersonalProjectResults({
  personalSpaceId,
  projects,
  query,
  baseline,
  signal,
  limit = PROJECT_DISCOVERY_LIMIT,
  request = getJson<KnowledgeSearchResult>,
}: {
  personalSpaceId: string
  projects: PersonalProject[]
  query: string
  baseline: KnowledgeSearchResult
  signal?: AbortSignal
  limit?: number
  request?: (
    url: string,
    init?: Pick<RequestInit, 'signal'>,
  ) => Promise<KnowledgeSearchResult>
}): Promise<PersonalProjectDiscovery> {
  const baselineIds = searchResultIds(baseline)
  const candidates = projects.slice(0, limit)
  const outcomes: Array<
    | { status: 'empty' | 'failed'; project: PersonalProject }
    | { status: 'matched'; project: PersonalProject; count: number; score: number }
  > = []

  for (let index = 0; index < candidates.length; index += PROJECT_DISCOVERY_CONCURRENCY) {
    signal?.throwIfAborted()
    const batch = candidates.slice(index, index + PROJECT_DISCOVERY_CONCURRENCY)
    outcomes.push(...await Promise.all(batch.map(async (project) => {
      try {
        const params = new URLSearchParams({
          personalSpaceId,
          personalProjectId: project.project_id,
          q: query,
          limit: '30',
        })
        const result = await request(`/api/search?${params}`, { signal })
        const added = searchResultItems(result).filter(({ key }) => !baselineIds.has(key))
        if (!added.length) return { status: 'empty' as const, project }
        return {
          status: 'matched' as const,
          project,
          count: added.length,
          score: Math.max(...added.map(({ score }) => score ?? 0)),
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return { status: 'failed' as const, project }
      }
    })))
  }

  return {
    matches: outcomes
      .filter(
        (outcome): outcome is Extract<typeof outcome, { status: 'matched' }> =>
          outcome.status === 'matched',
      )
      .sort((left, right) =>
        right.score - left.score
        || right.count - left.count
        || left.project.profile.name.localeCompare(right.project.profile.name),
      ),
    checked: outcomes.length,
    total: projects.length,
    failed: outcomes.filter(({ status }) => status === 'failed').length,
  }
}

export function projectDiscoverySummary(discovery: PersonalProjectDiscovery) {
  const failure = discovery.failed ? `；${discovery.failed} 个项目暂时无法检查` : ''
  if (discovery.matches.length) {
    return `其他个人项目中有候选内容。当前结果不会混入其他项目，可进入项目查看完整命中${failure}。`
  }
  if (!discovery.total) return '当前没有其他个人项目可继续检查。'
  if (discovery.failed === discovery.checked) return '其他个人项目暂时无法检查，请稍后重试。'
  if (discovery.checked < discovery.total) {
    return `已检查前 ${discovery.checked} / ${discovery.total} 个其他个人项目，也没有发现候选内容${failure}。`
  }
  return `已检查其他个人项目，也没有发现候选内容${failure}。`
}

function searchResultIds(result: KnowledgeSearchResult) {
  return new Set(searchResultItems(result).map(({ key }) => key))
}

function searchResultItems(result: KnowledgeSearchResult) {
  return [
    ...(result.entities ?? []).map((item) => ({
      key: `entity:${item.id}`,
      score: item.score,
    })),
    ...(result.facts ?? []).map((item) => ({
      key: `fact:${item.id}`,
      score: item.score,
    })),
  ]
}

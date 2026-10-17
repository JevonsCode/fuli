import { isConversationFallback } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import type {
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeNode,
  PersonalProject,
} from '@/types'

export type ProjectRelationWeightTier = 'related' | 'frequent' | 'close'

export interface FrequentProjectSummary {
  projectId: string
  name: string
  totalCount: number
  recent30dCount: number
  lastUsedAt: string | null
  tier: ProjectRelationWeightTier
  suggestKnowledgeReuse: boolean
  requiresHumanConfirmation: boolean
  grantsAccess: boolean
}

const WEIGHT_TIERS = new Set<ProjectRelationWeightTier>(['related', 'frequent', 'close'])
const NON_FORMAL_SCOPES = new Set(['temporary', 'session', 'conversation'])
const NON_FORMAL_LIFECYCLES = new Set(['archived'])

export function resolveProjectRelationWeightTier(
  input: {
    tier?: unknown
    recent30dCount?: unknown
    totalCount?: unknown
  } | null | undefined,
): ProjectRelationWeightTier | null {
  if (!input) return null
  const rawTier = typeof input.tier === 'string' ? input.tier.trim().toLowerCase() : ''
  if (WEIGHT_TIERS.has(rawTier as ProjectRelationWeightTier)) {
    return rawTier as ProjectRelationWeightTier
  }
  const recent = positiveInt(input.recent30dCount)
  const total = positiveInt(input.totalCount)
  const effectiveCount = recent > 0 ? recent : total
  if (effectiveCount >= 10) return 'close'
  if (effectiveCount >= 3) return 'frequent'
  if (effectiveCount >= 1) return 'related'
  return null
}

export function edgeWeightTier(
  edge: Pick<KnowledgeEdge, 'type' | 'attributes'> | null | undefined,
): ProjectRelationWeightTier | null {
  if (!edge) return null
  const tier = resolveProjectRelationWeightTier(edge.attributes)
  if (tier) return tier
  if (edge.type === 'PROJECT_MEMORY_ACCESS') return 'related'
  return null
}

export function projectRelationTierLabel(tier: ProjectRelationWeightTier): string {
  return t(`knowledge.domain.weightTiers.${tier}`)
}

export function isFormalProjectId(
  projectId: string | null | undefined,
  projects?: readonly PersonalProject[],
): boolean {
  const id = String(projectId ?? '').trim()
  if (!id) return false
  if (isConversationFallback({ project_id: id })) return false
  const matched = projects?.find((project) => project.project_id === id)
  if (matched) {
    const lifecycle = String(matched.profile?.lifecycle ?? '').trim().toLowerCase()
    if (NON_FORMAL_LIFECYCLES.has(lifecycle)) return false
  }
  return true
}

export function isFormalProjectNode(
  node: KnowledgeNode | null | undefined,
  projects?: readonly PersonalProject[],
): boolean {
  if (!node) return false
  if (node.type !== 'PersonalProject' && node.type !== 'RelatedPersonalProject') {
    return true
  }
  const attrs = node.attributes ?? {}
  const projectId = typeof attrs.projectId === 'string' && attrs.projectId.trim()
    ? attrs.projectId.trim()
    : extractProjectIdFromNodeId(node.id)
  if (
    isConversationFallback({ project_id: projectId })
    || isConversationFallback({ project_id: node.id })
  ) {
    return false
  }
  const scopeType = String(attrs.scope_type ?? attrs.scopeType ?? '').trim().toLowerCase()
  if (NON_FORMAL_SCOPES.has(scopeType)) return false

  const lifecycle = String(attrs.lifecycle ?? attrs.status ?? '').trim().toLowerCase()
  if (NON_FORMAL_LIFECYCLES.has(lifecycle)) return false

  return isFormalProjectId(projectId, projects)
}

export function filterFormalProjectGraph(
  graph: KnowledgeGraph,
  projects?: readonly PersonalProject[],
): KnowledgeGraph {
  const nodes = graph.nodes.filter((node) => isFormalProjectNode(node, projects))
  const retainedNodeIds = new Set(nodes.map(({ id }) => id))
  const edges = graph.edges.filter(
    (edge) =>
      retainedNodeIds.has(endpointId(edge.source))
      && retainedNodeIds.has(endpointId(edge.target)),
  )
  return { ...graph, nodes, edges }
}

export function extractFrequentProjects(
  graph: KnowledgeGraph | null | undefined,
  activeProjectId: string | null | undefined,
  projects?: readonly PersonalProject[],
): FrequentProjectSummary[] {
  const currentProjectId = String(activeProjectId ?? '').trim()
  if (!graph || !currentProjectId) return []

  const activeNode = graph.nodes.find(
    (node) =>
      node.type === 'PersonalProject'
      && String(node.attributes?.projectId ?? '').trim() === currentProjectId,
  )
  if (!activeNode) return []

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const projectsById = new Map((projects ?? []).map((project) => [project.project_id, project]))
  const summaries = new Map<string, FrequentProjectSummary>()

  const rawList = Array.isArray(activeNode.attributes?.frequentProjects)
    ? activeNode.attributes.frequentProjects
    : []

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const projectId = String(item.projectId ?? item.project_id ?? '').trim()
    if (!projectId || projectId === currentProjectId) continue
    if (!isFormalProjectId(projectId, projects)) continue
    const targetNode = graph.nodes.find(
      (node) =>
        (node.type === 'PersonalProject' || node.type === 'RelatedPersonalProject')
        && String(node.attributes?.projectId ?? '').trim() === projectId,
    )
    if (targetNode && !isFormalProjectNode(targetNode, projects)) continue

    const recent30dCount = positiveInt(item.recent30dCount)
    const totalCount = Math.max(recent30dCount, positiveInt(item.totalCount))
    const tier = resolveProjectRelationWeightTier({
      tier: item.tier,
      recent30dCount,
      totalCount,
    })
    if (!tier) continue

    const name = String(
      item.name
      ?? targetNode?.name
      ?? projectsById.get(projectId)?.profile.name
      ?? projectId,
    ).trim() || projectId

    summaries.set(projectId, {
      projectId,
      name,
      totalCount,
      recent30dCount,
      lastUsedAt: typeof item.lastUsedAt === 'string' ? item.lastUsedAt : null,
      tier,
      suggestKnowledgeReuse: Boolean(item.suggestKnowledgeReuse ?? (tier === 'close')),
      requiresHumanConfirmation: item.requiresHumanConfirmation !== false,
      grantsAccess: false,
    })
  }

  for (const edge of graph.edges) {
    if (edge.type !== 'PROJECT_MEMORY_ACCESS') continue
    if (endpointId(edge.source) !== activeNode.id) continue
    const targetNode = nodesById.get(endpointId(edge.target))
    if (!targetNode || !isFormalProjectNode(targetNode, projects)) continue
    const projectId = String(
      targetNode.attributes?.projectId ?? extractProjectIdFromNodeId(targetNode.id),
    ).trim()
    if (!projectId || projectId === currentProjectId || summaries.has(projectId)) continue
    if (!isFormalProjectId(projectId, projects)) continue

    const attrs = edge.attributes ?? {}
    const recent30dCount = positiveInt(attrs.recent30dCount)
    const totalCount = Math.max(recent30dCount, positiveInt(attrs.totalCount))
    const tier = edgeWeightTier(edge)
    if (!tier) continue

    summaries.set(projectId, {
      projectId,
      name: targetNode.name || projectsById.get(projectId)?.profile.name || projectId,
      totalCount,
      recent30dCount,
      lastUsedAt: typeof attrs.lastUsedAt === 'string' ? attrs.lastUsedAt : null,
      tier,
      suggestKnowledgeReuse: Boolean(attrs.suggestKnowledgeReuse ?? (tier === 'close')),
      requiresHumanConfirmation: attrs.requiresHumanConfirmation !== false,
      grantsAccess: false,
    })
  }

  return [...summaries.values()]
    .sort(
      (left, right) =>
        right.recent30dCount - left.recent30dCount
        || right.totalCount - left.totalCount
        || left.projectId.localeCompare(right.projectId),
    )
    .slice(0, 3)
}

function positiveInt(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0
}

function extractProjectIdFromNodeId(nodeId: string): string {
  const parts = String(nodeId ?? '').split(':')
  return parts.length >= 3 ? parts.slice(2).join(':') : String(nodeId ?? '')
}

function endpointId(endpoint: string | KnowledgeNode): string {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint
}

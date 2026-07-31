import { t } from '@/i18n'
import type { KnowledgeGraph, KnowledgeNode } from '@/types'

export interface ParentProject {
  projectId: string
  name: string
  summary: string
  nodeId: string
  relationId: string
}

export interface ProjectHierarchyView {
  graph: KnowledgeGraph
  parents: ParentProject[]
}

export function separateParentProjects(
  graph: KnowledgeGraph,
  activeProjectId: string | null,
): ProjectHierarchyView {
  if (!activeProjectId) return { graph, parents: [] }

  const activeProject = graph.nodes.find(
    (node) =>
      node.type === 'PersonalProject'
      && node.attributes?.projectId === activeProjectId,
  )
  if (!activeProject) return { graph, parents: [] }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const parentsByNodeId = new Map<string, ParentProject>()

  for (const edge of graph.edges) {
    if (edge.type !== 'PART_OF' || endpointId(edge.source) !== activeProject.id) continue
    const parent = nodesById.get(endpointId(edge.target))
    if (!parent || !isProjectNode(parent)) continue
    const parentProjectId = parent.attributes?.projectId
    if (typeof parentProjectId !== 'string' || !parentProjectId) continue
    if (!parentsByNodeId.has(parent.id)) {
      parentsByNodeId.set(parent.id, {
        projectId: parentProjectId,
        name: parent.name,
        summary: parent.summary || t('knowledge.domain.hierarchy.parentSummary'),
        nodeId: parent.id,
        relationId: edge.id,
      })
    }
  }

  if (!parentsByNodeId.size) return { graph, parents: [] }

  const parentNodeIds = new Set(parentsByNodeId.keys())
  const nodes = graph.nodes.filter(({ id }) => !parentNodeIds.has(id))
  const retainedNodeIds = new Set(nodes.map(({ id }) => id))
  const edges = graph.edges.filter(
    (edge) =>
      retainedNodeIds.has(endpointId(edge.source))
      && retainedNodeIds.has(endpointId(edge.target)),
  )

  return {
    graph: { ...graph, nodes, edges },
    parents: [...parentsByNodeId.values()],
  }
}

function endpointId(endpoint: string | KnowledgeNode) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint
}

function isProjectNode(node: KnowledgeNode) {
  return node.type === 'PersonalProject' || node.type === 'RelatedPersonalProject'
}

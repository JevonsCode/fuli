import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

export interface ProjectRelative {
  id: string
  projectId: string
  name: string
}

export interface ProjectFamily {
  parents: ProjectRelative[]
  siblings: ProjectRelative[]
  children: ProjectRelative[]
}

const isProject = (node: KnowledgeNode | undefined): node is KnowledgeNode =>
  node?.type === 'PersonalProject' || node?.type === 'RelatedPersonalProject'
const endpoint = (value: KnowledgeEdge['source']) => typeof value === 'object' && value !== null ? (value as KnowledgeNode).id : String(value)

// Where a project sits among the projects in the drawn graph: a PART_OF edge
// points from a child to its parent. Siblings share a parent. Only projects
// the graph holds are named; nothing is fetched.
export function projectFamily(graph: KnowledgeGraph | null, project: KnowledgeNode): ProjectFamily {
  if (!graph) return { parents: [], siblings: [], children: [] }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const partOf = graph.edges.filter(edge => edge.type === 'PART_OF')
    .map(edge => ({ child: nodes.get(endpoint(edge.source)), parent: nodes.get(endpoint(edge.target)) }))
    .filter((link): link is { child: KnowledgeNode; parent: KnowledgeNode } => isProject(link.child) && isProject(link.parent))
  const relative = (node: KnowledgeNode): ProjectRelative => ({ id: node.id, projectId: String(node.attributes?.projectId ?? ''), name: node.name })
  const unique = (list: KnowledgeNode[]) => [...new Map(list.map(node => [node.id, node])).values()].map(relative)

  const parents = partOf.filter(link => link.child.id === project.id).map(link => link.parent)
  const parentIds = new Set(parents.map(parent => parent.id))
  return {
    parents: unique(parents),
    siblings: unique(partOf.filter(link => parentIds.has(link.parent.id) && link.child.id !== project.id).map(link => link.child)),
    children: unique(partOf.filter(link => link.parent.id === project.id).map(link => link.child)),
  }
}

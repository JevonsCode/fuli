import { endpointId } from '@/features/knowledge/model'
import type { KnowledgeGraph, PersonalProject } from '@/types'
import { isFormalProject } from './project-origin'

type ProjectListingOptions = {
  showTemporary: boolean
  selectedProjectId: string | null
}

/** A selected URL stays accessible; archive visibility is never relaxed. */
export function isListedProject(project: Pick<PersonalProject, 'project_id' | 'scope_type' | 'status' | 'profile'>, options: ProjectListingOptions) {
  if (project.status === 'archived' || project.profile.lifecycle === 'archived') return false
  return options.showTemporary || project.project_id === options.selectedProjectId || isFormalProject(project)
}

/** Filter display projections only. Keep the source graph for direct item links. */
export function filterListedProjectGraph(graph: KnowledgeGraph, projects: readonly PersonalProject[], options: ProjectListingOptions): KnowledgeGraph {
  const byId = new Map(projects.map(project => [project.project_id, project]))
  const hiddenIds = new Set(projects.filter(project => !isListedProject(project, options)).map(project => project.project_id))
  const hiddenRoots = new Set<string>()
  for (const node of graph.nodes) {
    const attrs = node.attributes ?? {}
    const isProject = node.type === 'PersonalProject' || node.type === 'RelatedPersonalProject'
    if (!isProject) continue
    const id = String(attrs.projectId ?? (node.id.split(':').slice(2).join(':') || node.id))
    const project = byId.get(id) ?? {
      project_id: id,
      scope_type: (attrs.scope_type ?? attrs.scopeType) as PersonalProject['scope_type'],
      status: String(attrs.status ?? ''),
      profile: { name: node.name, lifecycle: String(attrs.lifecycle ?? ''), origin: String(attrs.origin ?? '') },
    }
    if (!isListedProject(project, options)) {
      hiddenRoots.add(node.id)
      hiddenIds.add(id)
      // Provider profile IDs use the internal UUID from the projection root,
      // not the logical project_id exposed by the project picker.
      if (node.id.startsWith('personal-project:')) {
        hiddenIds.add(node.id.slice('personal-project:'.length))
      }
    }
  }
  const hiddenProfilePrefixes = [...hiddenIds].map(id => `project-profile:${id}:`)
  const nodes = graph.nodes.filter(node => !hiddenRoots.has(node.id)
    && !hiddenProfilePrefixes.some(prefix => node.id.startsWith(prefix)))
  const retainedIds = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(edge => retainedIds.has(endpointId(edge.source)) && retainedIds.has(endpointId(edge.target)))
  return { ...graph, nodes, edges }
}

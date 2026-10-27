import { endpointId } from '@/features/knowledge/model'
import type { KnowledgeGraph } from '@/types'

// 调整层级: where a dragged project may go in the person's hierarchy. A
// project's parent is its active PART_OF relation in the projects graph.

export interface OrganizeProject {
  projectId: string
  name: string
  nodeId: string
}

export interface ProjectTree {
  projects: OrganizeProject[]
  parentOf: Map<string, string>
}

export type ProjectDropTarget =
  | { kind: 'under'; projectId: string }
  | { kind: 'sibling' }
  | { kind: 'top' }

export interface ProjectMove {
  projectId: string
  parentProjectId: string | null
}

export type ProjectDropRefusal = 'self' | 'cycle' | 'unchanged'

const DROP_ATTRIBUTE = 'data-project-drop'
const SEARCH_RESULT_LIMIT = 6

export function projectTree(graph: KnowledgeGraph | null): ProjectTree {
  const projects: OrganizeProject[] = []
  const projectIdByNode = new Map<string, string>()
  for (const node of graph?.nodes ?? []) {
    const projectId = node.attributes?.projectId
    if (node.type !== 'PersonalProject' || typeof projectId !== 'string' || !projectId) continue
    projects.push({ projectId, name: node.name, nodeId: node.id })
    projectIdByNode.set(node.id, projectId)
  }
  const parentOf = new Map<string, string>()
  for (const edge of graph?.edges ?? []) {
    if (edge.type !== 'PART_OF' || edge.invalid_at || edge.attributes?.status !== 'active') continue
    const child = projectIdByNode.get(endpointId(edge.source))
    const parent = projectIdByNode.get(endpointId(edge.target))
    if (child && parent && !parentOf.has(child)) parentOf.set(child, parent)
  }
  return { projects, parentOf }
}

export function projectForNode(tree: ProjectTree, nodeId: string) {
  return tree.projects.find((project) => project.nodeId === nodeId) ?? null
}

export function projectName(tree: ProjectTree, projectId: string | null | undefined) {
  return tree.projects.find((project) => project.projectId === projectId)?.name ?? projectId ?? ''
}

// The move a drop asks for, or why it changes nothing or cannot be made.
export function resolveProjectDrop(
  tree: ProjectTree,
  projectId: string,
  target: ProjectDropTarget,
): { move: ProjectMove } | { refusal: ProjectDropRefusal } {
  const parent = tree.parentOf.get(projectId) ?? null
  if (target.kind === 'under') {
    if (target.projectId === projectId) return { refusal: 'self' }
    if (descendantsOf(tree, projectId).has(target.projectId)) return { refusal: 'cycle' }
    if (target.projectId === parent) return { refusal: 'unchanged' }
    return { move: { projectId, parentProjectId: target.projectId } }
  }
  if (!parent) return { refusal: 'unchanged' }
  if (target.kind === 'top') return { move: { projectId, parentProjectId: null } }
  return { move: { projectId, parentProjectId: tree.parentOf.get(parent) ?? null } }
}

function acceptsProjectDrop(tree: ProjectTree, projectId: string, target: ProjectDropTarget) {
  return 'move' in resolveProjectDrop(tree, projectId, target)
}

// Projects the dragged one can move under, matching what the person typed.
export function searchMoveTargets(tree: ProjectTree, projectId: string, query: string) {
  const text = query.trim().toLocaleLowerCase()
  if (!text) return []
  return tree.projects
    .filter((project) => [project.name, project.projectId]
      .some((value) => value.toLocaleLowerCase().includes(text)))
    .filter((project) => acceptsProjectDrop(tree, projectId, { kind: 'under', projectId: project.projectId }))
    .slice(0, SEARCH_RESULT_LIMIT)
}

// The drop panel's targets carry data-project-drop="sibling" | "top" | "under:<projectId>".
export function dropTargetAttribute(target: ProjectDropTarget) {
  return target.kind === 'under' ? `under:${target.projectId}` : target.kind
}

export function dropTargetAt(element: Element | null): ProjectDropTarget | null {
  const value = element?.closest(`[${DROP_ATTRIBUTE}]`)?.getAttribute(DROP_ATTRIBUTE)
  if (value === 'sibling' || value === 'top') return { kind: value }
  if (value?.startsWith('under:')) return { kind: 'under', projectId: value.slice('under:'.length) }
  return null
}

export function sameDropTarget(a: ProjectDropTarget | null, b: ProjectDropTarget | null) {
  return Boolean(a && b) && dropTargetAttribute(a!) === dropTargetAttribute(b!)
}

function descendantsOf(tree: ProjectTree, projectId: string) {
  const children = new Map<string, string[]>()
  for (const [child, parent] of tree.parentOf) {
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found = new Set<string>()
  const pending = [projectId]
  while (pending.length) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        pending.push(child)
      }
    }
  }
  return found
}

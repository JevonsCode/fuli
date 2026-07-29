import type { LocationQueryRaw } from 'vue-router'

export type KnowledgeMode = 'directory' | 'graph'
export type KnowledgeScope = 'personal' | 'public'

function segment(value: string) {
  return encodeURIComponent(value)
}

export function personalProjectsPath(
  spaceId: string,
  mode: KnowledgeMode = 'graph',
  projectId?: string | null,
  options: {
    itemKind?: 'entity' | 'relationship' | null
    itemId?: string | null
  } = {},
) {
  const base = `/personal/${segment(spaceId)}/projects`
  const project = projectId ? `/${segment(projectId)}` : ''
  const item = options.itemKind && options.itemId
    ? `/${options.itemKind}/${segment(options.itemId)}`
    : ''
  return `${base}${project}/${mode}${item}`
}

export function knowledgePath(
  scope: KnowledgeScope,
  spaceId: string,
  mode: KnowledgeMode = 'directory',
  options: {
    projectId?: string | null
    itemKind?: 'entity' | 'relationship' | null
    itemId?: string | null
  } = {},
) {
  const base = `/knowledge/${scope}/${segment(spaceId)}`
  const project = options.projectId ? `/${segment(options.projectId)}` : ''
  const item = options.itemKind && options.itemId
    ? `/${options.itemKind}/${segment(options.itemId)}`
    : ''
  return `${base}${project}/${mode}${item}`
}

export function routeQuery(source: URLSearchParams): LocationQueryRaw {
  const query: LocationQueryRaw = {}
  for (const name of ['q', 'type', 'quadrant', 'profile', 'status']) {
    const value = source.get(name)
    if (value) query[name] = value
  }
  const contexts = source.getAll('context').filter(Boolean).slice(0, 12)
  if (contexts.length) query.context = contexts
  return query
}

export type KnowledgeMode = 'overview' | 'directory' | 'graph'
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


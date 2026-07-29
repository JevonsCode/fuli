import type { RouteLocationRaw } from 'vue-router'

import {
  knowledgePath,
  personalProjectsPath,
  routeQuery,
  type KnowledgeMode,
  type KnowledgeScope,
} from './paths'

const VIEWS = new Set([
  'overview',
  'personal-profile',
  'personal-projects',
  'public-projects',
  'graph',
  'review',
  'connections',
])

export function legacyRouteFromUrl(url: URL): RouteLocationRaw | null {
  const deepLink = legacyKnowledgeHash(url.hash)
  if (deepLink) return deepLink

  const requestedView = bounded(url.searchParams.get('view'))
  if (!requestedView || !VIEWS.has(requestedView)) return null

  const simplePaths: Record<string, string> = {
    overview: '/',
    'personal-profile': '/preferences',
    'public-projects': '/public-projects',
    review: '/review',
    connections: '/connections',
  }
  if (simplePaths[requestedView]) return { path: simplePaths[requestedView] }

  const scope = bounded(url.searchParams.get('scope'))
  const spaceId = bounded(url.searchParams.get('space'))
  const projectId = bounded(url.searchParams.get('project'))
  const mode = normalizeMode(url.searchParams.get('mode'), requestedView)
  const query = routeQuery(url.searchParams)

  if (requestedView === 'personal-projects') {
    if (!spaceId) return { path: '/personal/current/projects/graph', query }
    return {
      path: personalProjectsPath(spaceId, mode, projectId),
      query,
    }
  }

  if (requestedView === 'graph') {
    if (!spaceId || (scope !== 'personal' && scope !== 'public')) {
      return { path: '/knowledge', query }
    }
    return {
      path: knowledgePath(scope as KnowledgeScope, spaceId, mode, { projectId }),
      query,
    }
  }

  return null
}

function legacyKnowledgeHash(hash: string): RouteLocationRaw | null {
  const match = hash.match(
    /^#\/knowledge\/(personal|project)\/([^/]+)\/(entity|relationship)\/(.+)$/,
  )
  if (!match) return null
  const [, legacyScope, rawSpaceId, itemKind, rawItemId] = match
  const scope = legacyScope === 'project' ? 'public' : 'personal'
  const spaceId = safeDecode(rawSpaceId)
  const itemId = safeDecode(rawItemId)
  return {
    path: knowledgePath(scope, spaceId, 'directory', {
      itemKind: itemKind as 'entity' | 'relationship',
      itemId,
    }),
  }
}

function normalizeMode(value: string | null, view: string): KnowledgeMode {
  if (value === 'directory' || value === 'graph') return value
  return view === 'personal-projects' ? 'graph' : 'directory'
}

function bounded(value: string | null, limit = 512) {
  return value && value.length <= limit ? value : null
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

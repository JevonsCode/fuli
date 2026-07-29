const VIEWS = new Set([
  'overview',
  'personal-profile',
  'personal-projects',
  'public-projects',
  'graph',
  'review',
  'connections'
]);
const KNOWLEDGE_VIEWS = new Set(['personal-projects', 'graph']);
const MODES = new Set(['directory', 'graph']);
const FILTERS = {
  type: 'all',
  quadrant: 'all',
  profile: 'all',
  status: 'current'
};
const ROUTE_PARAMS = [
  'view',
  'scope',
  'space',
  'project',
  'mode',
  'q',
  'type',
  'quadrant',
  'profile',
  'status',
  'context'
];

export function readConsoleRoute(location = globalThis.location) {
  const params = new URLSearchParams(location?.search ?? '');
  const requestedView = boundedValue(params.get('view'));
  const view = VIEWS.has(requestedView) ? requestedView : 'overview';
  if (!KNOWLEDGE_VIEWS.has(view)) return { view, knowledge: null };

  const defaultMode = view === 'personal-projects' ? 'graph' : 'directory';
  const requestedMode = boundedValue(params.get('mode'));
  const scope = boundedValue(params.get('scope'));
  const spaceId = boundedValue(params.get('space'));
  const projectId = boundedValue(params.get('project'));
  const contexts = uniqueBoundedValues(params.getAll('context'), 12);

  return {
    view,
    knowledge: {
      mode: MODES.has(requestedMode) ? requestedMode : defaultMode,
      space: scope && spaceId && (scope === 'personal' || scope === 'public')
        ? { scope, spaceId, projectId: projectId || null }
        : null,
      query: boundedValue(params.get('q'), 500) ?? '',
      type: boundedValue(params.get('type')) ?? FILTERS.type,
      quadrant: boundedValue(params.get('quadrant')) ?? FILTERS.quadrant,
      profile: boundedValue(params.get('profile')) ?? FILTERS.profile,
      status: boundedValue(params.get('status')) ?? FILTERS.status,
      contexts
    }
  };
}

export function graphSpaceRoute(space) {
  if (!space?.id) return null;
  return {
    scope: space.providerUrl ? 'public' : 'personal',
    spaceId: String(space.id),
    projectId: space.personalProjectId ? String(space.personalProjectId) : null
  };
}

export function findRouteSpaceKey(spaces, target) {
  if (!target) return null;
  const matches = [...(spaces?.entries?.() ?? [])].filter(([, space]) => {
    const scope = space.providerUrl ? 'public' : 'personal';
    return scope === target.scope &&
      String(space.id) === target.spaceId &&
      String(space.personalProjectId ?? '') === String(target.projectId ?? '');
  });
  return matches.length === 1 ? matches[0][0] : null;
}

export function consoleRouteUrl(route, location = globalThis.location) {
  const base = location?.href ?? 'http://localhost/';
  const url = new URL(base, 'http://localhost/');
  for (const name of ROUTE_PARAMS) url.searchParams.delete(name);
  url.hash = '';

  if (route.view !== 'overview') url.searchParams.set('view', route.view);
  const knowledge = KNOWLEDGE_VIEWS.has(route.view) ? route.knowledge : null;
  if (knowledge) {
    url.searchParams.set('mode', MODES.has(knowledge.mode) ? knowledge.mode : 'directory');
    if (knowledge.space) {
      url.searchParams.set('scope', knowledge.space.scope);
      url.searchParams.set('space', knowledge.space.spaceId);
      if (knowledge.space.projectId) {
        url.searchParams.set('project', knowledge.space.projectId);
      }
    }
    setNonDefault(url.searchParams, 'q', knowledge.query, '');
    setNonDefault(url.searchParams, 'type', knowledge.type, FILTERS.type);
    setNonDefault(url.searchParams, 'quadrant', knowledge.quadrant, FILTERS.quadrant);
    setNonDefault(url.searchParams, 'profile', knowledge.profile, FILTERS.profile);
    setNonDefault(url.searchParams, 'status', knowledge.status, FILTERS.status);
    for (const contextId of uniqueBoundedValues(knowledge.contexts ?? [], 12)) {
      url.searchParams.append('context', contextId);
    }
  }

  return `${url.pathname}${url.search}`;
}

export function writeConsoleRoute(route, {
  history = globalThis.history,
  location = globalThis.location,
  replace = false
} = {}) {
  const target = consoleRouteUrl(route, location);
  const current = `${location?.pathname ?? '/'}${location?.search ?? ''}${location?.hash ?? ''}`;
  if (target === current) return false;
  history?.[replace ? 'replaceState' : 'pushState']?.(null, '', target);
  return true;
}

function setNonDefault(params, name, value, defaultValue) {
  if (value && value !== defaultValue) params.set(name, value);
}

function boundedValue(value, limit = 256) {
  return value && value.length <= limit ? value : null;
}

function uniqueBoundedValues(values, limit) {
  return [...new Set(values.map((value) => boundedValue(value)).filter(Boolean))].slice(0, limit);
}

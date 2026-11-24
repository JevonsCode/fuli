import { validationError } from '../app/application-error.js';
import { agentInterfaceCatalog, interfaceForRequest, interfaceForRoute } from './interface-catalog.js';

// What list_agent_interfaces answers. The whole catalog is about 50 KB, so an
// Agent asking whether one console change has an interface reads an index
// first and then the one domain, route group or route it needs. Every view is
// cut from agentInterfaceCatalog(), the only source; nothing here restates it.
const DETAILS = 'domains names each domain\'s tools; readRouteDomains also have console read routes. areas counts each '
  + 'route group\'s console changes in coverage\'s order. Pass domain for one domain in full, area for one group\'s entries '
  + '(access, reason or undo, category, toolName), or route (as listed, or METHOD /api/... path) for one entry.';
// The order of each areas count, the order coverage lists them in.
const ACCESS_ORDER = ['agent', 'agent_delegable', 'agent_delegable_off', 'agent_relayed', 'local_user_only'];

// A route's group: the segment after /api (or the first one for a route
// outside /api), so 'POST /api/peer/join' is in peer.
function routeArea(route) {
  const segments = route.split(' ')[1].split('/');
  return segments[1] === 'api' ? segments[2] : segments[1];
}

export function agentInterfaceView({ toolName, domain, area, route } = {}) {
  if ([toolName, domain, area, route].filter((value) => value !== undefined).length > 1) {
    throw validationError('Pass at most one of toolName, domain, area and route');
  }
  const catalog = agentInterfaceCatalog();
  if (domain !== undefined) return domainView(catalog, domain);
  if (area !== undefined) return areaView(catalog, area);
  if (route !== undefined) return routeView(catalog, route);
  return indexView(catalog);
}

function indexView({ schemaVersion, contract, guidance, coverage, delegationCategories, uiMutationParity, readWorkflows }) {
  const areas = {};
  for (const { route, access } of uiMutationParity) {
    const counts = areas[routeArea(route)] ??= ACCESS_ORDER.map(() => 0);
    counts[ACCESS_ORDER.indexOf(access)] += 1;
  }
  return { schemaVersion, contract, guidance, coverage, delegationCategories,
    domains: Object.fromEntries(readWorkflows.map(({ domain, toolNames }) => [domain, toolNames])),
    readRouteDomains: readWorkflows.filter(({ readRoutes }) => readRoutes).map(({ domain }) => domain),
    areas, details: DETAILS };
}

function domainView({ contract, readWorkflows }, domain) {
  const workflow = readWorkflows.find((item) => item.domain === domain);
  return workflow ? { contract, readWorkflow: workflow } : { found: false, domain,
    message: 'No such domain; domains lists every one.', domains: readWorkflows.map((item) => item.domain) };
}

function areaView({ contract, uiMutationParity }, area) {
  const entries = uiMutationParity.filter((entry) => routeArea(entry.route) === area);
  return entries.length ? { contract, area, uiMutationParity: entries }
    : { found: false, area, message: 'No such route group; areas lists every one.', areas: areaNames(uiMutationParity) };
}

function routeView({ contract, uiMutationParity }, route) {
  const [method, path = ''] = route.trim().split(/\s+/);
  const entry = interfaceForRoute(route.trim()) ?? interfaceForRequest(method.toUpperCase(), path.split('?')[0]);
  return entry ? { contract, area: routeArea(entry.route), uiMutationParity: [structuredClone(entry)] }
    : { found: false, route, message: 'No console change has this route; the catalog lists data changes only. '
      + 'Pass one of areas as area to see a group.', areas: areaNames(uiMutationParity) };
}

function areaNames(entries) {
  return [...new Set(entries.map(({ route }) => routeArea(route)))];
}

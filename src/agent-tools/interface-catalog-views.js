import { validationError } from '../app/application-error.js';
import { agentInterfaceCatalog, interfaceForRequest, interfaceForRoute, mostSpecificRoute } from './interface-catalog.js';

// What list_agent_interfaces answers. The whole catalog is about 50 KB, so an
// Agent asking whether one console change has an interface reads an index
// first and then the one domain, route group or route it needs. Every view is
// cut from agentInterfaceCatalog(), the only source; nothing here restates it.
const DETAILS = 'domains lists tools; readRouteDomains lists domains with console reads. areas counts changes in order '
  + '[agent, agent_delegable, agent_delegable_off, agent_relayed, local_user_only]. areaTools lists their agent tools. '
  + 'Pass domain for its workflow, area for access/reason/undo/category/toolName, route for one entry '
  + '(as listed or METHOD /api/... path), or toolName for its schema.';
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
  const areaTools = {};
  for (const entry of uiMutationParity) {
    const area = routeArea(entry.route);
    const counts = areas[area] ??= ACCESS_ORDER.map(() => 0);
    counts[ACCESS_ORDER.indexOf(entry.access)] += 1;
    for (const name of entryTools(entry)) {
      const names = areaTools[area] ??= [];
      if (!names.includes(name)) names.push(name);
    }
  }
  return { schemaVersion, contract, guidance, coverage, delegationCategories,
    domains: Object.fromEntries(readWorkflows.map(({ domain, toolNames }) => [domain, toolNames])),
    readRouteDomains: readWorkflows.filter(({ readRoutes }) => readRoutes).map(({ domain }) => domain),
    areas, areaTools, details: DETAILS };
}

function domainView({ contract, readWorkflows }, domain) {
  const workflow = readWorkflows.find((item) => item.domain === domain);
  return workflow ? { contract, readWorkflow: workflow } : { found: false, domain,
    message: 'No such domain; domains lists every one.', domains: readWorkflows.map((item) => item.domain) };
}

function areaView({ contract, uiMutationParity, readWorkflows }, area) {
  const entries = uiMutationParity.filter((entry) => routeArea(entry.route) === area);
  if (!entries.length) {
    return { found: false, area, message: 'No such route group; areas lists every one.', areas: areaNames(uiMutationParity) };
  }
  // The domains whose tools these entries name, for reading what goes with the change.
  const tools = new Set(entries.flatMap(entryTools));
  const domains = readWorkflows.filter(({ toolNames }) => toolNames.some((name) => tools.has(name))).map(({ domain }) => domain);
  return { contract, area, uiMutationParity: entries, ...(domains.length ? { domains } : {}) };
}

function routeView({ contract, uiMutationParity, readWorkflows }, route) {
  const parts = route.trim().split(/\s+/);
  if (parts.length !== 2) {
    return { found: false, route, message: 'Write route as METHOD /api/... (for example POST /api/peer/join), '
      + 'or pass one of areas as area.', areas: areaNames(uiMutationParity) };
  }
  const method = parts[0].toUpperCase();
  const path = parts[1].split('?')[0].replace(/(.)\/+$/, '$1');
  const entry = interfaceForRoute(`${method} ${path}`) ?? interfaceForRequest(method, path);
  if (entry) return { contract, area: routeArea(entry.route), uiMutationParity: [structuredClone(entry)] };
  // A read route changes nothing, so it has no access entry; the domain that lists it says how to use it.
  const read = mostSpecificRoute(readWorkflows.flatMap(({ readRoutes }) => readRoutes ?? []), method, path);
  if (read) {
    return { contract, readRoute: true, route: read, domain: readWorkflows.find(({ readRoutes }) => readRoutes?.includes(read)).domain,
      message: 'A read route: it changes nothing, so it has no access entry. Pass this domain for how to use it.' };
  }
  return { found: false, route, message: 'No console change or read route has this route. '
    + 'Pass one of areas as area to see a group.', areas: areaNames(uiMutationParity) };
}

function entryTools({ toolName, toolNames }) {
  return toolNames ?? (toolName ? [toolName] : []);
}

function areaNames(entries) {
  return [...new Set(entries.map(({ route }) => routeArea(route)))];
}

import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { AgentService, ServiceKind, ServiceLiveState } from './agent-services'

// The services table: search and filters live in the URL (?q=, ?agent=,
// ?project=, ?kind=, ?state=), so Back, a refresh or a shared link shows the
// same rows. 'all' and an empty search are left out of the URL.
export const SERVICE_KIND_FILTERS = ['all', 'workbench', 'agent_service'] as const
export const SERVICE_STATE_FILTERS = ['all', 'running', 'stopped', 'unknown'] as const

export interface ServiceTableQuery {
  search: string
  agent: string
  project: string
  kind: 'all' | ServiceKind
  state: 'all' | ServiceLiveState
}

const QUERY_KEYS = ['q', 'agent', 'project', 'kind', 'state']

function first(value: LocationQuery[string]) {
  const values = Array.isArray(value) ? value : [value]
  return values.find((item): item is string => typeof item === 'string' && item !== '') ?? ''
}

function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  return (allowed as readonly string[]).includes(value) ? value as T : allowed[0]
}

export function readServiceTableQuery(query: LocationQuery): ServiceTableQuery {
  return {
    search: first(query.q),
    agent: first(query.agent) || 'all',
    project: first(query.project) || 'all',
    kind: oneOf(SERVICE_KIND_FILTERS, first(query.kind)),
    state: oneOf(SERVICE_STATE_FILTERS, first(query.state)),
  }
}

/** Write the filters into the URL, keeping every unrelated key. */
export function serviceTableLocationQuery(query: LocationQuery, value: ServiceTableQuery): LocationQueryRaw {
  const next: LocationQueryRaw = Object.fromEntries(Object.entries(query).filter(([key]) => !QUERY_KEYS.includes(key)))
  if (value.search.trim()) next.q = value.search.trim()
  for (const key of ['agent', 'project', 'kind', 'state'] as const) if (value[key] !== 'all') next[key] = value[key]
  return next
}

export interface ServiceNames { agent: (id: string | null) => string; project: (id: string | null) => string }

/**
 * The rows to show: those of the chosen FLA, project, kind and live state whose
 * purpose, address, command, FLA or project name contains the search; running
 * first, then the latest start.
 */
export function visibleServices(services: readonly AgentService[], query: ServiceTableQuery, names: ServiceNames, locale: string) {
  const needle = query.search.trim().toLocaleLowerCase(locale)
  const rows = services.filter(service =>
    (query.agent === 'all' || service.agentId === query.agent)
    && (query.project === 'all' || service.projectId === query.project)
    && (query.kind === 'all' || service.kind === query.kind)
    && (query.state === 'all' || service.live.state === query.state)
    && (!needle || [service.purpose, service.address, service.command, service.commandLine, String(service.pid ?? ''),
      names.agent(service.agentId), names.project(service.projectId)]
      .some(text => text?.toLocaleLowerCase(locale).includes(needle))))
  const rank = (service: AgentService) => (service.live.state === 'running' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

/** The FLAs and projects the records name, for the filter menus; each id once. */
export function serviceOwners(services: readonly AgentService[]) {
  const unique = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => Boolean(value)))]
  return { agents: unique(services.map(service => service.agentId)), projects: unique(services.map(service => service.projectId)) }
}

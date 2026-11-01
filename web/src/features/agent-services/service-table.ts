import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { AgentService, ServiceLiveState } from './agent-services'

// The services list: the search lives in the URL (?q=), so Back, a refresh or
// a shared link shows the same rows; an empty search is left out of the URL.
// Rows are grouped by their live state, which stands in for a state filter.

function first(value: LocationQuery[string]) {
  const values = Array.isArray(value) ? value : [value]
  return values.find((item): item is string => typeof item === 'string' && item !== '') ?? ''
}

export function readServiceSearch(query: LocationQuery): string {
  return first(query.q)
}

/** Write the search into the URL, keeping every unrelated key. */
export function serviceSearchLocationQuery(query: LocationQuery, search: string): LocationQueryRaw {
  const next: LocationQueryRaw = Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'q'))
  return search.trim() ? { ...next, q: search.trim() } : next
}

export interface ServiceNames { agent: (id: string | null) => string; project: (id: string | null) => string }

/**
 * The rows whose purpose, address, command, PID, FLA or project name contains
 * the search, latest start first.
 */
export function visibleServices(services: readonly AgentService[], search: string, names: ServiceNames, locale: string) {
  const needle = search.trim().toLocaleLowerCase(locale)
  const rows = services.filter(service => !needle || [service.purpose, service.address, service.command, service.commandLine,
    String(service.pid ?? ''), names.agent(service.agentId), names.project(service.projectId)]
    .some(text => text?.toLocaleLowerCase(locale).includes(needle)))
  return [...rows].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
}

const GROUP_ORDER: readonly ServiceLiveState[] = ['running', 'unknown', 'stopped']

/** Running first, then those FULI cannot confirm, then stopped; empty groups are left out. */
export function serviceGroups(rows: readonly AgentService[]) {
  return GROUP_ORDER.map(key => ({ key, rows: rows.filter(service => service.live.state === key) }))
    .filter(group => group.rows.length)
}

import { z } from 'zod'

import { shapeOf } from '@/api/response-shape'

export type Format = 'standard' | 'vscode' | 'server'
export type ClientStatus = 'connected' | 'changed' | 'skills_left' | 'removed' | 'not_connected' | 'not_detected' | 'unknown'
// overwritten: the client wrote back the entry an update had just replaced (rec#106).
export type ClientChange = { from: ClientStatus, to: ClientStatus, detectedAt: string, overwritten?: boolean }
// A FULI installation: its folder (home as ~) and package version, when it has one.
export type FuliInstall = { path: string, version: string | null }
// What an outdated entry runs, against the console's own installation.
export type ConfiguredInstall = FuliInstall & { exists: boolean, sameAsConsole: boolean }
export type ClientObservation = { id: string, label: string, status: ClientStatus, detected: boolean, manualOnly?: boolean, manualUrl?: string, previouslyConnected: boolean,
  restartSessions?: number,
  changes: ClientChange[], lastKnownStatus?: ClientStatus | null,
  overwritten?: boolean, configuredInstall?: ConfiguredInstall,
  // Present for a client FULI can quit and reopen here; running is null when that could not be read.
  restart?: { running: boolean | null } }
// A client the person described by hand (an agent-clients extension file).
export type CustomClient = { id: string, label: string, detected: boolean, status: ClientStatus, mcpPaths: string[], removable: boolean }
// `available` is false when agent-installer could not be run: nothing is known about any client then.
export type ConnectionStatus = { observedAt: string, historySaved: boolean, available?: boolean, clients: ClientObservation[],
  customClients?: CustomClient[], installs?: { console: FuliInstall, others: (FuliInstall & { clients: string[] })[] } }
// `reason` names a failure the person can act on: agent-installer could not be downloaded here.
// client_running: a client that writes its cached configuration back is, or may be, running (rec#106).
export type ConnectionResult = { id: string, status: 'connected' | 'partial' | 'failed', restartRequired: boolean,
  reason?: 'client_component_unavailable' | 'client_running' }
// 「重启并更新」's answer: which step ended it (src/system/client-restart.js).
const RESTART_STATUSES = ['connected', 'quit_failed', 'connect_failed', 'reopen_failed', 'check_failed'] as const
export type RestartStatus = typeof RESTART_STATUSES[number]
// reopened: false when a failed write also left the app closed.
export const restartResultShape = shapeOf(z.looseObject({ id: z.string(), status: z.enum(RESTART_STATUSES), reopened: z.boolean().optional() }))
// The MCP file formats a custom client can name (agent-installer's write formats).
export const CUSTOM_CLIENT_FORMATS = ['mcp-servers-json', 'opencode-json', 'codex-toml'] as const
export type CustomClientFormat = typeof CUSTOM_CLIENT_FORMATS[number]

// The connect button says what it does for this status; it runs the same install every time.
export function connectActionKey(status: ClientStatus): 'connect' | 'reconnect' | 'update' {
  if (status === 'changed') return 'update'
  return status === 'skills_left' || status === 'removed' ? 'reconnect' : 'connect'
}

// The clients the list shows: those on this machine, plus any that FULI was in before.
export function shownClients(observation: ConnectionStatus | null): ClientObservation[] {
  return (observation?.clients ?? []).filter((client) => client.status !== 'not_detected')
}

// Whether FULI can write this client's configuration itself (「接入」), as opposed to the person by hand.
export function canConnect(client: ClientObservation): boolean {
  return client.detected && !client.manualOnly && client.status !== 'unknown'
}

// 「已接入 X/Y 个客户端」: the shown clients and every client described by hand.
export function connectionSummary(observation: ConnectionStatus | null): { connected: number, total: number } {
  const clients = [...shownClients(observation), ...(observation?.customClients ?? [])]
  return { connected: clients.filter((client) => client.status === 'connected').length, total: clients.length }
}

// 「重启并更新」 replaces 「更新接入」 while the client runs, or FULI cannot tell, since it would write its old entry back (rec#106).
export function offersRestart(client: ClientObservation): boolean {
  return client.status === 'changed' && client.restart !== undefined && client.restart.running !== false
}

// An outdated entry's explanation: what differs, then the one way to fix it (rec#106).
export function changedExplanation(client: ClientObservation, own: FuliInstall | undefined):
  { difference: string, params: Record<string, string>, step: 'restart' | 'restartRunning' | 'quitFirst' | 'update' } {
  const install = client.configuredInstall
  const params: Record<string, string> = { client: client.label }
  let difference = 'generic'
  if (client.overwritten) difference = 'overwritten'
  else if (install?.version && own?.version && install.version !== own.version) {
    difference = 'olderVersion'
    Object.assign(params, { configured: install.version, console: own.version })
  } else if (install && !install.sameAsConsole) difference = 'otherInstall'
  // An overwrite already says why the app must close; otherwise the restart says it.
  const step = offersRestart(client) ? (client.overwritten ? 'restart' : 'restartRunning') : client.overwritten ? 'quitFirst' : 'update'
  return { difference, params, step }
}

// The details dialog lists the newest change first.
export function changesNewestFirst(client: ClientObservation): ClientChange[] {
  return [...client.changes].reverse()
}

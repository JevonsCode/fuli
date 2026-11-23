import { z } from 'zod'

import { shapeOf } from '@/api/response-shape'

export type Format = 'standard' | 'vscode' | 'server'
// probing: FULI is still looking for this client's command here; it is neither found nor missing yet.
export type ClientStatus = 'connected' | 'changed' | 'skills_left' | 'removed' | 'not_connected' | 'not_detected' | 'probing' | 'unknown'
// overwritten: the client wrote back the entry an update had just replaced (rec issue 106).
export type ClientChange = { from: ClientStatus, to: ClientStatus, detectedAt: string, overwritten?: boolean }
// A FULI installation: its folder (home as ~) and package version, when it has one.
export type FuliInstall = { path: string, version: string | null }
// What an outdated entry runs, against the console's own installation.
export type ConfiguredInstall = FuliInstall & { exists: boolean, sameAsConsole: boolean }
// firstRun: this client still asks the person something itself the first time
// FULI is used in it, and that is still ahead; `command` is the step FULI can run for one folder.
// inWsl: installed only inside WSL on this Windows computer, where FULI cannot write it.
export type ClientObservation = { id: string, label: string, status: ClientStatus, detected: boolean, manualOnly?: boolean, manualUrl?: string, previouslyConnected: boolean,
  firstRun?: { id: string, command: string }, inWsl?: boolean,
  restartSessions?: number,
  changes: ClientChange[], lastKnownStatus?: ClientStatus | null,
  overwritten?: boolean, configuredInstall?: ConfiguredInstall,
  // Present for a client FULI can quit and reopen here; running is null when that could not be read.
  restart?: { running: boolean | null },
  // What FULI installs into this client and each part's state (agent-installer's components).
  components?: Record<string, string> }
// A client the person described by hand (an agent-clients extension file).
export type CustomClient = { id: string, label: string, detected: boolean, status: ClientStatus, mcpPaths: string[], removable: boolean,
  components?: Record<string, string> }
// What a runner says about itself on its own 客户端接入 page (docs/runner.md):
// its host, and which of the two computers runs the older FULI (rec issue 144).
export type RunnerFacts = { version: string, hostName: string | null, hostReachable: boolean, hostVersion: string | null,
  skew?: { older: 'host' | 'runner' } }
// `available` is false when agent-installer could not be run: nothing is known about any client then.
// probing: at least one client is still being looked for; the next read waits for that to finish.
export type ConnectionStatus = { observedAt: string, historySaved: boolean, available?: boolean, probing?: boolean, clients: ClientObservation[],
  customClients?: CustomClient[], installs?: { console: FuliInstall, others: (FuliInstall & { clients: string[] })[] },
  runner?: RunnerFacts }
// `reason` names a failure the person can act on: agent-installer could not be downloaded here.
// client_running: a client that writes its cached configuration back is, or may be, running (rec issue 106).
export type ConnectionResult = { id: string, status: 'connected' | 'partial' | 'failed', restartRequired: boolean,
  reason?: 'client_component_unavailable' | 'client_running' }
// 「重启并更新」's answer: which step ended it (src/system/client-restart.js).
const RESTART_STATUSES = ['connected', 'quit_failed', 'connect_failed', 'reopen_failed', 'check_failed'] as const
export type RestartStatus = typeof RESTART_STATUSES[number]
// reopened: false when a failed write also left the app closed.
export const restartResultShape = shapeOf(z.looseObject({ id: z.string(), status: z.enum(RESTART_STATUSES), reopened: z.boolean().optional() }))

// A client tile's mark: a connected client gets the shared check icon; the other states keep these plain marks.
// The mark inside a client's status circle: an icon, so it sits in the centre at any font;
// a client FULI is simply not in shows the empty circle.
export const STATUS_ICONS: Readonly<Record<ClientStatus, 'check' | 'close' | 'warning' | 'help' | null>> = { connected: 'check',
  changed: 'warning', skills_left: 'warning', removed: 'close', not_connected: null, not_detected: null, probing: null, unknown: 'help' }

// The connect button says what it does for this status; it runs the same install every time.
export function connectActionKey(status: ClientStatus): 'connect' | 'reconnect' | 'update' {
  if (status === 'changed') return 'update'
  return status === 'skills_left' || status === 'removed' ? 'reconnect' : 'connect'
}

// The clients the list shows: those on this machine, plus any that FULI was in before,
// plus one installed only inside WSL, whose tile says why FULI cannot connect it.
export function shownClients(observation: ConnectionStatus | null): ClientObservation[] {
  return (observation?.clients ?? []).filter((client) => client.status !== 'not_detected' || client.inWsl)
}

// One tile of the client grid: a detected client, or one the person described by hand (`custom`).
export type ClientTile = ClientObservation & { custom?: { mcpPaths: string[], removable: boolean } }

// The grid's tiles: the shown clients, then every client described by hand, whatever its status.
export function clientTiles(observation: ConnectionStatus | null): ClientTile[] {
  return [...shownClients(observation), ...(observation?.customClients ?? []).map((client): ClientTile => ({
    id: client.id, label: client.label, status: client.status, detected: client.detected, previouslyConnected: false, changes: [],
    ...(client.components ? { components: client.components } : {}),
    custom: { mcpPaths: client.mcpPaths, removable: client.removable } }))]
}

// The parts FULI installs into a client, in the order a person reads them: the
// MCP entry first, then what makes it automatic, then the client's extras.
export const CLIENT_PARTS = ['mcp', 'hooks', 'plugin', 'skills', 'instructions', 'permissions', 'prompts'] as const
export type ClientPart = typeof CLIENT_PARTS[number]
export type PartState = 'current' | 'outdated' | 'missing' | 'conflict'

// A tile's parts and each one's state; a part the client takes none of is left out.
// A client FULI is not in at all (every part missing or unreadable) lists none:
// its tile's own sentence and 接入 already say so, and a row of 「未装」 says nothing more.
export function clientParts(client: Pick<ClientTile, 'components'>): { part: ClientPart, state: PartState }[] {
  const components = client.components ?? {}
  const states: readonly string[] = ['current', 'outdated', 'missing', 'conflict']
  const parts = CLIENT_PARTS.filter((part) => states.includes(components[part] ?? ''))
    .map((part) => ({ part, state: components[part] as PartState }))
  return parts.some(({ state }) => state === 'current' || state === 'outdated') ? parts : []
}

// What a connected client can do with FULI, the same row on every tile so tiles compare at a glance:
// each capability installed (its part's state) or 'unsupported' when this client takes no such part,
// with what that costs in the chip's title. Auto start and close comes from hooks or a plugin.
export const CLIENT_CAPABILITIES = ['mcp', 'lifecycle', 'skills', 'instructions', 'permissions', 'prompts'] as const
export type ClientCapability = typeof CLIENT_CAPABILITIES[number]
export type CapabilityState = PartState | 'unsupported'

export function clientCapabilities(client: Pick<ClientTile, 'components'>):
  { capability: ClientCapability, part: ClientPart, state: CapabilityState }[] {
  const parts = clientParts(client)
  if (!parts.length) return []
  const states = new Map<ClientPart, PartState>(parts.map(({ part, state }) => [part, state]))
  return CLIENT_CAPABILITIES.map((capability) => {
    const part: ClientPart = capability === 'lifecycle' ? (states.has('plugin') && !states.has('hooks') ? 'plugin' : 'hooks') : capability
    return { capability, part, state: states.get(part) ?? 'unsupported' }
  })
}

// Neither hooks nor a plugin: task entry and its close depend on the Agent, and nothing is captured by itself.
export function withoutLifecycle(client: Pick<ClientTile, 'components'>): boolean {
  const parts = clientParts(client).map(({ part }) => part)
  return parts.length > 0 && !parts.includes('hooks') && !parts.includes('plugin')
}

// Whether FULI can write this client's configuration itself (「接入」), as opposed to the person by hand.
// A client described by hand need not be found first: FULI creates the file the person named.
export function canConnect(client: ClientTile): boolean {
  return (client.detected || Boolean(client.custom)) && !client.manualOnly && client.status !== 'unknown'
}

// A client described by hand that FULI is not in yet: its tile says where the entry will go.
export function awaitsFirstConnection(client: ClientTile): boolean {
  return Boolean(client.custom) && (client.status === 'not_detected' || client.status === 'not_connected')
}

// 「已接入 X/Y 个客户端」: the shown clients and every client described by hand.
// `notInstalled` counts the built-in clients that are not on this computer, so
// the line never reads as "all of them" while FULI knows of clients it is not
// in (rec issue 90, rec issue 145).
export function connectionSummary(observation: ConnectionStatus | null):
  { connected: number, total: number, notInstalled: number } {
  const clients = clientTiles(observation)
  return { connected: clients.filter((client) => client.status === 'connected').length, total: clients.length,
    notInstalled: (observation?.clients ?? []).filter((client) => client.status === 'not_detected' && !client.inWsl).length }
}

// 「重启并更新」 replaces 「更新接入」 while the client runs, or FULI cannot tell, since it would write its old entry back (rec issue 106).
export function offersRestart(client: ClientObservation): boolean {
  return client.status === 'changed' && client.restart !== undefined && client.restart.running !== false
}

// An outdated entry's explanation: what differs, then the one way to fix it (rec issue 106).
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

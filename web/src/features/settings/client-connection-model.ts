export type Format = 'standard' | 'vscode' | 'server'
export type ClientStatus = 'connected' | 'changed' | 'skills_left' | 'removed' | 'not_connected' | 'not_detected' | 'unknown'
export type ClientChange = { from: ClientStatus, to: ClientStatus, detectedAt: string }
export type ClientObservation = { id: string, label: string, status: ClientStatus, detected: boolean, manualOnly?: boolean, manualUrl?: string, previouslyConnected: boolean,
  changes: ClientChange[], lastKnownStatus?: ClientStatus | null }
// A client the person described by hand (an agent-clients extension file).
export type CustomClient = { id: string, label: string, detected: boolean, status: ClientStatus, mcpPaths: string[], removable: boolean }
// `available` is false when agent-installer could not be run: nothing is known about any client then.
export type ConnectionStatus = { observedAt: string, historySaved: boolean, available?: boolean, clients: ClientObservation[],
  customClients?: CustomClient[] }
export type ConnectionResult = { id: string, status: 'connected' | 'partial' | 'failed', restartRequired: boolean }
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

// 「已接入 X/Y 个客户端」: the shown clients and every client described by hand.
export function connectionSummary(observation: ConnectionStatus | null): { connected: number, total: number } {
  const clients = [...shownClients(observation), ...(observation?.customClients ?? [])]
  return { connected: clients.filter((client) => client.status === 'connected').length, total: clients.length }
}

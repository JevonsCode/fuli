export type Format = 'standard' | 'vscode' | 'server'
export type ClientStatus = 'connected' | 'changed' | 'skills_left' | 'removed' | 'not_connected' | 'not_detected' | 'unknown'
export type ClientChange = { from: ClientStatus, to: ClientStatus, detectedAt: string }
export type ClientObservation = { id: string, label: string, status: ClientStatus, detected: boolean, manualOnly?: boolean, manualUrl?: string, previouslyConnected: boolean,
  changes: ClientChange[], lastKnownStatus?: ClientStatus | null }
export type ConnectionStatus = { observedAt: string, historySaved: boolean, clients: ClientObservation[] }
export type ConnectionResult = { id: string, status: 'connected' | 'partial' | 'failed', restartRequired: boolean }

// The connect button says what it does for this status; it runs the same install every time.
export function connectActionKey(status: ClientStatus): 'connect' | 'reconnect' | 'update' {
  if (status === 'changed') return 'update'
  return status === 'skills_left' || status === 'removed' ? 'reconnect' : 'connect'
}

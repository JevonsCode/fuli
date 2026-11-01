import { describe, expect, it } from 'vitest'
import { connectionSummary, shownClients, type ClientObservation, type ConnectionStatus } from './client-connection-model'

const client = (id: string, status: ClientObservation['status']): ClientObservation =>
  ({ id, label: id, status, detected: status !== 'not_detected', previouslyConnected: false, changes: [] })

describe('client connection summary', () => {
  it('counts the clients shown and every client described by hand', () => {
    const observation: ConnectionStatus = { observedAt: '2026-11-01T00:00:00.000Z', historySaved: true, available: true,
      clients: [client('codex', 'connected'), client('cursor', 'changed'), client('kiro', 'not_detected'), client('gemini', 'removed')],
      customClients: [{ id: 'acme', label: 'Acme', detected: false, status: 'not_detected', mcpPaths: [], removable: true },
        { id: 'team', label: 'Team', detected: true, status: 'connected', mcpPaths: [], removable: false }] }
    expect(shownClients(observation).map(({ id }) => id)).toEqual(['codex', 'cursor', 'gemini'])
    expect(connectionSummary(observation)).toEqual({ connected: 2, total: 5 })
  })

  it('is empty before the first answer', () => {
    expect(connectionSummary(null)).toEqual({ connected: 0, total: 0 })
  })
})

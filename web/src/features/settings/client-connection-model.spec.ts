import { describe, expect, it } from 'vitest'
import { changedExplanation, changesNewestFirst, connectionSummary, offersRestart, shownClients, type ClientObservation, type ConnectionStatus } from './client-connection-model'

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

describe('an outdated entry explained (rec#106)', () => {
  const console = { path: '~/fuli-prerelease/FULI.app', version: '0.25.0' }
  const outdated = (extra: Partial<ClientObservation> = {}): ClientObservation => ({ ...client('claude-desktop', 'changed'), label: 'Claude Desktop',
    configuredInstall: { path: '/Applications/FULI.app', version: '0.23.0', exists: true, sameAsConsole: false }, ...extra })

  it('names both versions, then the one way to fix it', () => {
    expect(changedExplanation(outdated(), console)).toEqual({ difference: 'olderVersion', step: 'update',
      params: { client: 'Claude Desktop', configured: '0.23.0', console: '0.25.0' } })
    expect(changedExplanation(outdated({ configuredInstall: { path: '/x', version: '0.25.0', exists: true, sameAsConsole: false } }), console).difference)
      .toBe('otherInstall')
    expect(changedExplanation(outdated({ configuredInstall: undefined }), console).difference).toBe('generic')
  })

  it('says the client overwrote it and offers the restart only while it runs', () => {
    expect(changedExplanation(outdated({ overwritten: true }), console)).toMatchObject({ difference: 'overwritten', step: 'quitFirst' })
    const running = outdated({ overwritten: true, restart: { running: true } })
    expect(changedExplanation(running, console).step).toBe('restart')
    expect(offersRestart(running)).toBe(true)
    expect(changedExplanation(outdated({ restart: { running: true } }), console).step).toBe('restartRunning')
    expect(offersRestart(outdated({ restart: { running: false } }))).toBe(false)
    expect(offersRestart(outdated({ restart: { running: null } }))).toBe(false)
    expect(offersRestart({ ...running, status: 'connected' })).toBe(false)
  })

  it('lists changes newest first without touching the observation', () => {
    const changes = [{ from: 'changed', to: 'connected', detectedAt: '2026-11-10T13:15:42.000Z' },
      { from: 'connected', to: 'changed', detectedAt: '2026-11-10T13:18:31.000Z', overwritten: true }] as const
    const shown = outdated({ changes: [...changes] })
    expect(changesNewestFirst(shown).map(({ detectedAt }) => detectedAt)).toEqual([changes[1].detectedAt, changes[0].detectedAt])
    expect(shown.changes[0]!.detectedAt).toBe(changes[0].detectedAt)
  })
})

import { describe, expect, it } from 'vitest'
import { awaitsFirstConnection, canConnect, clientParts, withoutLifecycle, changedExplanation, changesNewestFirst, clientTiles, connectionSummary, offersRestart, shownClients, type ClientObservation, type ConnectionStatus } from './client-connection-model'
import { settingsMessages } from '../../i18n/messages/settings'

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
    // A client described by hand is a tile whatever its status, and FULI writes it before its file exists.
    const tiles = clientTiles(observation)
    expect(tiles.map(({ id }) => id)).toEqual(['codex', 'cursor', 'gemini', 'acme', 'team'])
    expect(tiles.map(canConnect)).toEqual([true, true, true, true, true])
    expect(canConnect(client('kiro', 'not_detected'))).toBe(false)
    expect(tiles.map(awaitsFirstConnection)).toEqual([false, false, false, true, false])
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
    // Not knowing whether it runs is treated as running: a plain write could be written back.
    expect(offersRestart(outdated({ restart: { running: null } }))).toBe(true)
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

describe('client connection copy', () => {
  it('keeps every 手动接入 / Add client string within 100 characters in both languages', () => {
    const strings = (value: unknown, key: string): [string, string][] => typeof value === 'string' ? [[key, value]]
      : Object.entries(value as Record<string, unknown>).flatMap(([name, inner]) => strings(inner, `${key}.${name}`))
    for (const locale of ['zh-CN', 'en-US'] as const) {
      for (const [key, text] of strings(settingsMessages[locale].connection.custom, locale)) {
        expect([...text].length, key).toBeLessThanOrEqual(100)
      }
    }
  })
})

describe('what FULI puts into a client', () => {
  it('lists each part a client takes, MCP first, with its state, and says when nothing starts or closes a task by itself', () => {
    const claudeCode = { components: { skills: 'current', permissions: 'current', hooks: 'outdated', mcp: 'current', prompts: 'unsupported' } }
    expect(clientParts(claudeCode)).toEqual([{ part: 'mcp', state: 'current' }, { part: 'hooks', state: 'outdated' },
      { part: 'skills', state: 'current' }, { part: 'permissions', state: 'current' }])
    expect(withoutLifecycle(claudeCode)).toBe(false)
    expect(withoutLifecycle({ components: { mcp: 'current' } })).toBe(true)
    expect(withoutLifecycle({ components: { plugin: 'missing', skills: 'missing' } })).toBe(false)
    // Nothing known says nothing.
    expect(clientParts({})).toEqual([])
    expect(withoutLifecycle({})).toBe(false)
  })
})

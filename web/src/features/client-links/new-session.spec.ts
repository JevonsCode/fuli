import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))

import type { ClientLinksManifest } from './model'
import { loadTerminalWays, newSessionWay, openInTerminal } from './new-session'

// Synthetic manifest and clients only.
const link = (id: string, template: string, parameters: string[]) => ({ id, opens: 'App', template,
  parameters: Object.fromEntries(parameters.map(name => [name, { format: name === 'sessionId' ? 'uuid' : 'any' }])) as never,
  platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest: ClientLinksManifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 3, updatedAt: '2026-11-08', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('thread', 'codex://threads/{sessionId}', ['sessionId']),
    link('new', 'codex://new?prompt={prompt}', ['prompt'])] },
  { id: 'synthetic_model', name: 'Synthetic', noSessionLink: null, sessionLinks: [link('new', 'cursor://synthetic/new?p={prompt}&m={model}', ['prompt', 'model'])] },
  { id: 'opencode', name: 'OpenCode', noSessionLink: 'Synthetic: none.', sessionLinks: [] },
] }

beforeEach(() => {
  getJson.mockReset()
  postJson.mockReset()
})

describe('newSessionWay', () => {
  const prompt = '#FLA Tonborg 讲讲 "这个" & 100%'
  it('prefers the documented prompt link, encoded, over a terminal', () => {
    expect(newSessionWay(manifest, { codex: { prompt: 'send' } }, { id: 'codex', sourceApplication: 'codex' }, { prompt }))
      .toEqual({ kind: 'link', href: `codex://new?prompt=${encodeURIComponent(prompt)}`, opens: 'App', carriesModel: false })
  })
  it('opens the terminal when the client has no prompt link, and nothing without either', () => {
    expect(newSessionWay(manifest, { opencode: { prompt: 'send', environment: 'wsl' } }, { id: 'opencode', sourceApplication: 'opencode' }, { prompt }))
      .toEqual({ kind: 'terminal', clientId: 'opencode', sendsPrompt: true })
    expect(newSessionWay(manifest, {}, { id: 'opencode', sourceApplication: 'opencode' }, { prompt })).toBeNull()
    expect(newSessionWay(null, { 'gemini-cli': { prompt: 'send' } }, { id: 'gemini-cli', sourceApplication: null }, { prompt }))
      .toEqual({ kind: 'terminal', clientId: 'gemini-cli', sendsPrompt: true })
  })
  it('says when a link carries the model, and skips a link that needs a missing one', () => {
    const client = { id: 'synthetic', sourceApplication: 'synthetic_model' }
    expect(newSessionWay(manifest, {}, client, { prompt: 'p', model: 'fast' }))
      .toMatchObject({ kind: 'link', href: 'cursor://synthetic/new?p=p&m=fast', carriesModel: true })
    expect(newSessionWay(manifest, {}, client, { prompt: 'p' })).toBeNull()
  })
})

describe('terminal requests', () => {
  it('asks once for every client and reads only ways the server gives', async () => {
    postJson.mockResolvedValueOnce({ launcher: 'available', ways: { opencode: { prompt: 'send', environment: 'wsl' } } })
    expect(await loadTerminalWays(['codex', 'opencode'])).toEqual({ opencode: { prompt: 'send', environment: 'wsl' } })
    expect(postJson.mock.calls[0].slice(0, 2)).toEqual(['/api/session-launch/new-session/ways', { clients: ['codex', 'opencode'] }])
    postJson.mockResolvedValueOnce({ launcher: 'unavailable', reason: 'offline' })
    expect(await loadTerminalWays(['codex'])).toEqual({})
    expect(await loadTerminalWays([])).toEqual({})
    expect(postJson).toHaveBeenCalledTimes(2)
    expect(getJson).not.toHaveBeenCalled()
  })
  it('posts the click with the client and the prompt', async () => {
    postJson.mockResolvedValueOnce({ status: 'launch_requested' })
    await openInTerminal({ kind: 'terminal', clientId: 'gemini-cli', sendsPrompt: true }, 'hello')
    expect(postJson).toHaveBeenCalledWith('/api/session-launch/new-session', { client: 'gemini-cli', prompt: 'hello' }, expect.anything())
  })
})

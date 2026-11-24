import { describe, expect, it } from 'vitest'

import { CAPTURE_SOURCES, captureSourceFor, shownCaptureClients } from './capture-clients'

const sources = (clients: ReturnType<typeof shownCaptureClients>) => clients.map(({ source }) => source)
type Listed = [id: string, status: string, sourceApplication: string | null, label?: string]
const detection = (clients: Listed[], customClients: { id: string, label: string }[] = []) => ({
  clients: clients.map(([id, status, sourceApplication, label]) => ({ id, status, sourceApplication, label: label ?? id })), customClients })

describe('capture clients', () => {
  it('records a client under its own source, and one without a source of its own under other', () => {
    expect(captureSourceFor({ sourceApplication: 'claude_code' })).toBe('claude_code')
    expect(captureSourceFor({ sourceApplication: 'claude' })).toBe('claude')
    expect(captureSourceFor({ sourceApplication: 'kiro' })).toBe('kiro')
    expect(captureSourceFor({ sourceApplication: null })).toBe('other')
    expect(captureSourceFor({})).toBe('other')
  })

  it('lists a switch for every client the client card lists, the ones without a capture adapter included', () => {
    const shown = shownCaptureClients(detection([['claude-code', 'connected', 'claude_code', 'Claude Code'], ['codex', 'not_detected', 'codex'],
      ['cursor', 'not_connected', 'cursor', 'Cursor'], ['claude-desktop', 'connected', 'claude', 'Claude Desktop'], ['kiro', 'connected', 'kiro', 'Kiro'],
      ['gemini', 'connected', null, 'Gemini CLI']], [{ id: 'acme-agent', label: 'Acme Agent' }]), {})
    expect(sources(shown)).toEqual(['claude_code', 'cursor', 'claude', 'kiro', 'other'])
    // `claude` also records the claude.ai / Cowork remote connector, so its switch is not named Claude Desktop alone.
    expect(shown.find(({ source }) => source === 'claude')!.label).toBe('Claude')
    expect(shown.find(({ source }) => source === 'kiro')!.label).toBe('Kiro')
    // `other` names the clients it stands for on this machine.
    expect(shown.at(-1)!.covers).toEqual(['Gemini CLI', 'Acme Agent'])
  })

  it('keeps a client that is turned off even when it is no longer detected', () => {
    const shown = shownCaptureClients(detection([['claude-code', 'connected', 'claude_code'], ['codex', 'not_detected', 'codex']]),
      { disabledSources: ['codex', 'other'] })
    // `other` turned off is also a legacy OpenCode, Antigravity and DeepSeek Harness off (rec#11 D-64), so each can be turned back on.
    expect(sources(shown)).toEqual(['claude_code', 'codex', 'opencode', 'dsh', 'antigravity', 'other'])
    expect(sources(shownCaptureClients(detection([]), { disabledSources: ['other'], capturedSources: ['opencode', 'dsh', 'antigravity'] })))
      .toEqual(['other'])
  })

  it('falls back to every source when the clients cannot be read', () => {
    expect(sources(shownCaptureClients(null, {}))).toEqual([...CAPTURE_SOURCES])
    expect(sources(shownCaptureClients({ available: false, clients: [] }, {}))).toEqual([...CAPTURE_SOURCES])
    expect(shownCaptureClients(null, {}).find(({ source }) => source === 'kiro')!.label).toBe('Kiro')
  })
})

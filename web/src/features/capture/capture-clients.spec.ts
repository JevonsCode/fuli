import { describe, expect, it } from 'vitest'

import { CAPTURE_CLIENTS, captureSourceFor, shownCaptureClients } from './capture-clients'

const sources = (clients: ReturnType<typeof shownCaptureClients>) => clients.map(([source]) => source)
const detection = (clients: Array<[string, string]>) => ({ clients: clients.map(([id, status]) => ({ id, status })) })

describe('capture clients', () => {
  it('maps agent-installer client ids to capture sources, and nothing for a client FULI does not capture from', () => {
    expect(captureSourceFor('claude-code')).toBe('claude_code')
    expect(captureSourceFor('codex')).toBe('codex')
    expect(captureSourceFor('cursor')).toBe('cursor')
    expect(captureSourceFor('opencode')).toBe('opencode')
    expect(captureSourceFor('claude-desktop')).toBeNull()
    expect(captureSourceFor('kiro')).toBeNull()
  })

  it('lists only the capturable clients this machine has', () => {
    const shown = shownCaptureClients(detection([['claude-code', 'connected'], ['codex', 'not_detected'],
      ['cursor', 'not_connected'], ['claude-desktop', 'connected']]), {})
    expect(sources(shown)).toEqual(['claude_code', 'cursor'])
  })

  it('keeps a client that is turned off even when it is no longer detected', () => {
    const shown = shownCaptureClients(detection([['claude-code', 'connected'], ['codex', 'not_detected']]),
      { disabledSources: ['codex', 'other'] })
    // `other` turned off is a legacy OpenCode off (rec#11 D-64).
    expect(sources(shown)).toEqual(['claude_code', 'codex', 'opencode'])
    expect(sources(shownCaptureClients(detection([]), { disabledSources: ['other'], capturedSources: ['opencode'] }))).toEqual([])
  })

  it('falls back to every capturable client when the clients cannot be read', () => {
    expect(shownCaptureClients(null, {})).toBe(CAPTURE_CLIENTS)
    expect(shownCaptureClients({ available: false, clients: [] }, {})).toBe(CAPTURE_CLIENTS)
  })
})

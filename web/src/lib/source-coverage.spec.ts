import { describe, expect, it } from 'vitest'

import { coversClient } from './source-coverage'

describe('source coverage (rec#11 D-64)', () => {
  it('allows OpenCode for a legacy profile listing other without rewriting it', () => {
    const profile = { allowedClients: ['codex', 'other'] }
    expect(coversClient(profile.allowedClients, 'opencode')).toBe(true)
    expect(profile.allowedClients).toEqual(['codex', 'other'])
    expect(coversClient(['opencode'], 'other')).toBe(false)
    expect(coversClient(['other'], 'codex')).toBe(false)
    expect(coversClient(undefined, 'opencode')).toBe(false)
  })

  it('ignores only the legacy alias for an explicit client choice', () => {
    expect(coversClient(['other'], 'opencode', { explicit: ['opencode'] })).toBe(false)
    expect(coversClient(['other', 'opencode'], 'opencode', { explicit: ['opencode'] })).toBe(true)
    expect(coversClient(['other'], 'other', { explicit: ['opencode'] })).toBe(true)
  })
})

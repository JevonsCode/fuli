import { describe, expect, it } from 'vitest'

import { captureSourceOff, withCaptureSource } from './capture-sources'

describe('capture sources (rec#11 D-64)', () => {
  it('keeps OpenCode off when a policy from before it had its own name turned `other` off', () => {
    expect(captureSourceOff({ disabledSources: ['other'] }, 'opencode')).toBe(true)
    expect(captureSourceOff({ disabledSources: ['opencode'] }, 'opencode')).toBe(true)
    expect(captureSourceOff({ disabledSources: ['codex'] }, 'opencode')).toBe(false)
    expect(captureSourceOff({ disabledSources: ['other'] }, 'codex')).toBe(false)
    const explicit = { disabledSources: ['other'], capturedSources: ['opencode'] }
    expect(captureSourceOff(explicit, 'opencode')).toBe(false)
    expect(captureSourceOff(explicit, 'other')).toBe(true)
    expect(captureSourceOff({ ...explicit, disabledSources: ['other', 'opencode'] }, 'opencode')).toBe(true)
  })

  it('turns OpenCode on without enabling other clients, and removes its override when turned off', () => {
    const policy = { disabledSources: ['other', 'codex'] }
    const on = withCaptureSource(policy, 'opencode', true)
    expect(on).toEqual({ disabledSources: ['other', 'codex'], capturedSources: ['opencode'] })
    expect(withCaptureSource(on, 'opencode', true)).toEqual(on)
    expect(withCaptureSource(on, 'opencode', false)).toEqual({
      disabledSources: ['other', 'codex', 'opencode'], capturedSources: [],
    })
    expect(policy.disabledSources).toEqual(['other', 'codex'])
  })

  it('keeps other explicit capture choices when changing one client', () => {
    expect(withCaptureSource({ disabledSources: ['codex'], capturedSources: ['opencode'] }, 'cursor', false))
      .toEqual({ disabledSources: ['codex', 'cursor'], capturedSources: ['opencode'] })
    expect(withCaptureSource({ disabledSources: ['codex', 'cursor'] }, 'cursor', true))
      .toEqual({ disabledSources: ['codex'], capturedSources: ['cursor'] })
  })
})

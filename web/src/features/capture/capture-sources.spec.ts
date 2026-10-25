import { describe, expect, it } from 'vitest'

import { captureSourceOff, withCaptureSource } from './capture-sources'

describe('capture sources (rec#11 D-64)', () => {
  it('keeps OpenCode off when a policy from before it had its own name turned `other` off', () => {
    expect(captureSourceOff(['other'], 'opencode')).toBe(true)
    expect(captureSourceOff(['opencode'], 'opencode')).toBe(true)
    expect(captureSourceOff(['codex'], 'opencode')).toBe(false)
    expect(captureSourceOff(['other'], 'codex')).toBe(false)
  })

  it('turns one client on or off, and turning OpenCode on lifts the `other` setting that kept it off', () => {
    expect(withCaptureSource(['codex'], 'cursor', false)).toEqual(['codex', 'cursor'])
    expect(withCaptureSource(['codex', 'cursor'], 'cursor', true)).toEqual(['codex'])
    expect(withCaptureSource(['other', 'codex'], 'opencode', true)).toEqual(['codex'])
    expect(withCaptureSource(['other'], 'opencode', false)).toEqual(['other', 'opencode'])
  })
})

import { describe, expect, it } from 'vitest'

import { savedCaptureScope } from './capture-onboarding'

describe('savedCaptureScope (rec#5 C10)', () => {
  it('names the answer saved settings amount to', () => {
    expect(savedCaptureScope({ enabled: false, projectMode: 'selected' })).toBe('off')
    expect(savedCaptureScope({ enabled: true })).toBe('all')
    expect(savedCaptureScope({ enabled: true, projectMode: 'all' })).toBe('all')
    expect(savedCaptureScope({ enabled: true, projectMode: 'selected', selectedProjectIds: ['thesis'] })).toBe('selected')
  })

  it('names none for settings no answer produces, or none read', () => {
    expect(savedCaptureScope({ enabled: true, projectMode: 'all_except' })).toBeNull()
    expect(savedCaptureScope(undefined)).toBeNull()
  })
})

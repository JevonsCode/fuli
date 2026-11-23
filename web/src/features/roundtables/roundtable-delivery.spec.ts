import { describe, expect, it } from 'vitest'
import { reasonPlace } from './roundtable-delivery'

describe('reasonPlace', () => {
  it('sends a reason that is a setting to where it is changed, and leaves one about the message alone', () => {
    expect(reasonPlace('lead_changed')).toEqual({ to: '/settings?tab=connections#peer', label: 'roundtable.reasonActions.share' })
    expect(reasonPlace('no_client')).toEqual({ to: '/settings?tab=clients', label: 'roundtable.reasonActions.clients' })
    expect(reasonPlace('nested_limit')).toBeNull()
    expect(reasonPlace(null)).toBeNull()
  })
})

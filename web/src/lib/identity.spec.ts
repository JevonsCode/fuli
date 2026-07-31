import { describe, expect, it } from 'vitest'

import { compactIdentity, graphNodeIdentity, identitySearchText } from './identity'

describe('identity helpers', () => {
  it('keeps canonical values searchable while presenting compact graph labels', () => {
    const uuid = '123e4567-e89b-42d3-a456-426614174000'

    expect(compactIdentity(uuid)).toBe('123e4567')
    expect(identitySearchText(uuid)).toContain(uuid)
    expect(graphNodeIdentity({
      id: 'personal-project:space-id:fuli',
      attributes: { projectId: 'fuli' },
    })).toBe('fuli')
    expect(graphNodeIdentity({ id: 'short-node-id' })).toBe('short-node-id')
  })
})

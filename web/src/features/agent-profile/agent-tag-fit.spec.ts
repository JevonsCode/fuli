import { describe, expect, it } from 'vitest'

import { fittingTagCount } from './agent-tag-fit'

describe('fittingTagCount', () => {
  it('shows every tag, with no room held for the more-chip, when they fit', () => {
    expect(fittingTagCount([60, 60], 128, 8, 40)).toBe(2)
    expect(fittingTagCount([], 0, 8, 40)).toBe(0)
  })

  it('leaves room for the more-chip once a tag is left out', () => {
    expect(fittingTagCount([60, 60, 60], 150, 8, 40)).toBe(1)
    expect(fittingTagCount([60, 60, 60], 180, 8, 40)).toBe(2)
  })

  it('shows only the more-chip in a row too narrow for the first tag', () => {
    expect(fittingTagCount([200, 60], 100, 8, 40)).toBe(0)
  })
})

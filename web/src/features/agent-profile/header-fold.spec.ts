import { describe, expect, it } from 'vitest'
import { headerFolds } from './header-fold'

describe('the FLA header fold', () => {
  it('folds once the work has scrolled, and opens again at the top', () => {
    expect(headerFolds(false, { scrollTop: 20, room: 800, headerHeight: 120 })).toBe(false)
    expect(headerFolds(false, { scrollTop: 40, room: 800, headerHeight: 120 })).toBe(true)
    expect(headerFolds(true, { scrollTop: 20, room: 740, headerHeight: 54 })).toBe(true)
    expect(headerFolds(true, { scrollTop: 2, room: 740, headerHeight: 54 })).toBe(false)
  })

  it('stays open when folding would leave too little to scroll, so it cannot bounce', () => {
    // Folding gives back 66px; 70px of scroll would leave 4, and the work would jump to the top.
    expect(headerFolds(false, { scrollTop: 40, room: 70, headerHeight: 120 })).toBe(false)
    expect(headerFolds(false, { scrollTop: 40, room: 90, headerHeight: 120 })).toBe(true)
  })
})

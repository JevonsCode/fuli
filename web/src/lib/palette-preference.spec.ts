import { afterEach, describe, expect, it } from 'vitest'
import { PALETTE_STORAGE_KEY, initPalettePreference, palettePreference, setPalettePreference } from './palette-preference'

afterEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.palette
})

describe('palette preference', () => {
  it('applies a chosen palette to the document and remembers it in this browser', () => {
    setPalettePreference('gold')
    expect(document.documentElement.dataset.palette).toBe('gold')
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('gold')

    setPalettePreference('jade')
    expect(document.documentElement.dataset.palette).toBeUndefined()
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBeNull()
  })

  it('restores a stored palette and ignores an unknown value', () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'indigo')
    initPalettePreference()
    expect(palettePreference.value).toBe('indigo')
    expect(document.documentElement.dataset.palette).toBe('indigo')

    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'neon')
    initPalettePreference()
    expect(palettePreference.value).toBe('jade')
    expect(document.documentElement.dataset.palette).toBeUndefined()
  })
})

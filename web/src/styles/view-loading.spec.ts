import { describe, expect, it } from 'vitest'
import vue from './vue.css?raw'

const rule = (selector: string) => {
  const start = vue.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return vue.slice(start, vue.indexOf('}', start))
}

// Jevons 11-01: a loading sits in the middle of the area it replaces, not in a
// 240px box at the top of the page.
describe('page-sized loading', () => {
  it('lays the page root out as a column while a page loading is in it', () => {
    const root = rule('.app-main .view:has(.view-loading)')
    expect(root).toContain('display: flex')
    expect(root).toContain('flex-direction: column')
  })

  it('grows every box around the loading into the free height, and only while it shows', () => {
    expect(rule('.app-main .view :has(.view-loading)')).toContain('flex: 1 0 auto')
    const parent = rule('.app-main .view :has(> .view-loading)')
    expect(parent).toContain('display: flex')
    expect(parent).toContain('flex-direction: column')
  })

  it('fills the rest of the area and centres the mark in both directions', () => {
    const loading = rule('.view-loading')
    for (const declaration of ['flex: 1 0 auto', 'align-self: stretch', 'justify-self: stretch', 'display: grid', 'place-items: center']) {
      expect(loading).toContain(declaration)
    }
  })
})

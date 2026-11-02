import { describe, expect, it } from 'vitest'
import { navDestinations } from '@/layouts/nav-destinations'
import { pageBackdrop } from './page-backdrops'

const dockKeys = navDestinations({ spaceId: 'space-1', publicProjects: true })
  .filter(destination => destination.placement === 'dock').map(destination => destination.key)
const everyBackdrop = [...dockKeys, 'settings', undefined].map(pageBackdrop)

describe('page backdrops', () => {
  it('gives every dock destination its own motif', () => {
    expect(dockKeys).toEqual(['constellation', 'agents', 'chat', 'memory', 'projects'])
    for (const key of dockKeys) expect(pageBackdrop(key).key).toBe(key)
    expect(new Set(dockKeys.map(key => pageBackdrop(key).layers.join(' | '))).size).toBe(dockKeys.length)
  })

  it('keeps the first backdrop for settings and any page outside the dock', () => {
    expect(pageBackdrop('settings').key).toBe('growth')
    expect(pageBackdrop(undefined)).toBe(pageBackdrop('settings'))
    expect(pageBackdrop('no-such-destination')).toBe(pageBackdrop('settings'))
  })

  it('splits each motif over two or three moving layers, so few layers are composited', () => {
    for (const { layers } of everyBackdrop) {
      expect(layers.length).toBeGreaterThanOrEqual(2)
      expect(layers.length).toBeLessThanOrEqual(3)
    }
  })

  it('paints with the theme tokens only, never a raw colour', () => {
    for (const { layers } of everyBackdrop) {
      const background = layers.join(', ')
      expect(background).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
      const tokens = new Set(background.match(/var\(--[\w-]+\)/g))
      expect([...tokens].every(token => ['var(--color-gold)', 'var(--color-success)', 'var(--color-ink)'].includes(token))).toBe(true)
    }
  })

  it('keeps every layer as faint as the first backdrop’s strongest glow', () => {
    for (const { layers } of everyBackdrop) {
      for (const layer of layers) {
        const strengths = [...layer.matchAll(/\) (\d+)%, transparent\)/g)].map(([, percent]) => Number(percent))
        expect(strengths.length).toBeGreaterThan(0)
        expect(Math.max(...strengths)).toBeLessThanOrEqual(13)
      }
    }
  })
})

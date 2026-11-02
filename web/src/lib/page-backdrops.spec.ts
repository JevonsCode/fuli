import { describe, expect, it } from 'vitest'
import { navDestinations } from '@/layouts/nav-destinations'
import { contrast, mixOver, semanticToken } from '@/test-support/colour-contrast'
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
      expect([...tokens].every(token => ['var(--color-glow-gold)', 'var(--color-glow-success)', 'var(--color-ink)'].includes(token))).toBe(true)
    }
  })

  it('keeps muted text over every glow at 4.5:1 at its strongest', () => {
    const [page, muted] = [semanticToken('--color-bg'), semanticToken('--color-muted')]
    for (const { key, layers } of everyBackdrop) {
      const tints = [...layers.join(', ').matchAll(/var\((--[\w-]+)\) (\d+)%, transparent\)/g)]
      expect(tints.length).toBeGreaterThan(0)
      for (const [, token, percent] of tints) {
        expect(contrast(muted, mixOver(page, semanticToken(token!), Number(percent))), `${key} ${token} ${percent}%`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

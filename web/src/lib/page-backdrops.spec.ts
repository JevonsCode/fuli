import { describe, expect, it } from 'vitest'
import { navDestinations } from '@/layouts/nav-destinations'
import { backdropPose, GROW_PERIOD, GROW_STEP } from './growing-backdrop'
import { pageBackdrop } from './page-backdrops'

const dockKeys = navDestinations({ spaceId: 'space-1', publicProjects: true })
  .filter(destination => destination.placement === 'dock').map(destination => destination.key)
const everyBackdrop = [...dockKeys, 'settings', undefined].map(pageBackdrop)

describe('page backdrops', () => {
  it('gives every dock destination its own motif', () => {
    expect(dockKeys).toEqual(['constellation', 'agents', 'chat', 'memory', 'projects'])
    for (const key of dockKeys) expect(pageBackdrop(key).key).toBe(key)
    expect(new Set(dockKeys.map(key => pageBackdrop(key).background)).size).toBe(dockKeys.length)
  })

  it('keeps the first backdrop for settings and any page outside the dock', () => {
    expect(pageBackdrop('settings').key).toBe('growth')
    expect(pageBackdrop(undefined)).toBe(pageBackdrop('settings'))
    expect(pageBackdrop('no-such-destination')).toBe(pageBackdrop('settings'))
  })

  it('paints with the theme tokens only, never a raw colour', () => {
    for (const { background } of everyBackdrop) {
      expect(background).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
      const tokens = new Set(background.match(/var\(--[\w-]+\)/g))
      expect([...tokens].every(token => ['var(--color-gold)', 'var(--color-success)', 'var(--color-ink)'].includes(token))).toBe(true)
    }
  })

  it('keeps every motif as faint as the first backdrop’s strongest glow', () => {
    for (const { background } of everyBackdrop) {
      const strengths = [...background.matchAll(/\) (\d+)%, transparent\)/g)].map(([, percent]) => Number(percent))
      expect(strengths.length).toBeGreaterThan(0)
      expect(Math.max(...strengths)).toBeLessThanOrEqual(13)
    }
  })

  it('moves under two pixels per step on a 1920×1080 screen and rests at its first pose', () => {
    // Translate percentages are of the layer, which overhangs the screen by 8% on every side.
    const width = 1.16 * 1920, height = 1.16 * 1080
    for (const { drift } of everyBackdrop) {
      expect(backdropPose(drift, 0)).toEqual(drift.from)
      let largest = 0
      for (let at = 0; at < GROW_PERIOD; at += GROW_STEP) {
        const [a, b] = [backdropPose(drift, at), backdropPose(drift, at + GROW_STEP)]
        largest = Math.max(largest, Math.abs(b.x - a.x) / 100 * width, Math.abs(b.y - a.y) / 100 * height)
      }
      expect(largest).toBeLessThan(2)
    }
  })
})

import { describe, expect, it } from 'vitest'

// Pages compose the design system instead of hand-building controls. These
// counts may only go down: lower them in the same change that rebuilds a page
// on UiButton / UiIconButton / UiToggle (2026-10-18 baseline: 195 / 9, after the app shell).
const BASELINE = { button: 195, switch: 9 }
const sources = import.meta.glob<string>(['../**/*.vue', '!./**'], { query: '?raw', import: 'default', eager: true })

describe('design system adoption', () => {
  it('never adds hand-built buttons or switches outside web/src/ui', () => {
    const all = Object.values(sources)
    expect(all.length).toBeGreaterThan(50)
    const button = all.reduce((sum, source) => sum + (source.match(/<button\b/g)?.length ?? 0), 0)
    const toggle = all.reduce((sum, source) => sum + (source.match(/role="switch"/g)?.length ?? 0), 0)
    expect(button, 'use UiButton / UiIconButton instead of a new <button>').toBeLessThanOrEqual(BASELINE.button)
    expect(toggle, 'use UiToggle instead of a new switch').toBeLessThanOrEqual(BASELINE.switch)
  })
})

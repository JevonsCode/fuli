import { describe, expect, it } from 'vitest'

// Every done or check mark draws the shared check icon (UiIcon "check", Lucide's
// check), never a ✓ or ✔ character, which renders as a font glyph (Jevons, 11-01).
const sources = import.meta.glob<string>(['../**/*.vue', '../**/*.ts', '../**/*.css', '!../**/*.spec.ts'], { query: '?raw', import: 'default', eager: true })
const GLYPH = /[✓✔√]|\\27(?:13|14)/

describe('check marks', () => {
  it('are always the shared check icon, never a text glyph', () => {
    const files = Object.entries(sources)
    expect(files.length).toBeGreaterThan(100)
    expect(files.filter(([, source]) => GLYPH.test(source)).map(([file]) => file)).toEqual([])
  })
})

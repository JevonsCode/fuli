import { describe, expect, it } from 'vitest'

// Colours live in the theme token files (styles/theme, styles/tokens.css), so a skin
// or theme recolours every page. Components and scripts name tokens only.
const sources = import.meta.glob<string>(['../**/*.vue', '../**/*.ts', '!../**/*.spec.ts'], { query: '?raw', import: 'default', eager: true })
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/g

describe('colour tokens', () => {
  it('keeps hard-coded colours out of components and scripts', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      [...source.matchAll(COLOUR_LITERAL)].map(match => `${file}: ${match[0]}`))
    expect(offenders).toEqual([])
  })
})

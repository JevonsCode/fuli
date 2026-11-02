import { describe, expect, it } from 'vitest'
import base from './base.css?raw'
import elements from './elements.css?raw'
import components from './components.css?raw'
import semantic from './semantic.css?raw'
import tailwind from './tailwind.css?raw'

// The theme is layered: base, semantic, then component tokens.
const declarations = (css: string) =>
  [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => ({ name: name!, value: value!.trim() }))
const block = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}
const lightSemantic = new Set(declarations(semantic.slice(0, semantic.indexOf('@media'))).map(({ name }) => name))
const componentNames = new Set(declarations(components).map(({ name }) => name))
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/

describe('theme layers', () => {
  it('keeps colour out of the base layer', () => {
    expect(base).not.toMatch(COLOUR_LITERAL)
  })

  it('maps every component token from exactly one semantic token', () => {
    expect(componentNames.size).toBeGreaterThan(15)
    for (const { name, value } of declarations(components)) {
      const source = value.match(/^var\((--[\w-]+)\)$/)?.[1]
      expect(source && lightSemantic.has(source), `${name}: ${value}`).toBe(true)
    }
  })

  it('builds Tailwind colour utilities only from component tokens', () => {
    const preset = block(tailwind, '@theme inline reference')
    const colours = declarations(preset).filter(({ name }) => name.startsWith('--color-'))
    expect(colours.length).toBeGreaterThan(15)
    for (const { name, value } of colours) {
      const source = value.match(/^var\((--[\w-]+)\)$/)?.[1]
      expect(source && componentNames.has(source), `${name}: ${value}`).toBe(true)
    }
    // Tailwind's own palette and rem-based scales are switched off.
    expect(block(tailwind, '@theme')).toMatch(/--color-\*:\s*initial/)
  })

  it('keeps one type scale: size leads, three weights, nothing bold', () => {
    const scale = Object.fromEntries(declarations(base).map(({ name, value }) => [name, value]))
    expect([scale['--text-title'], scale['--text-section'], scale['--text-card-title'], scale['--text-body'], scale['--text-meta']])
      .toEqual(['22px', '18px', '15px', '14px', '12px'])
    expect([scale['--weight-regular'], scale['--weight-medium'], scale['--weight-strong']]).toEqual(['400', '500', '600'])
    // Tailwind's weight utilities are exactly those three; headings use the scale.
    const preset = block(tailwind, '@theme inline reference')
    expect(declarations(preset).filter(({ name }) => name.startsWith('--font-weight-')).map(({ value }) => value))
      .toEqual(['var(--weight-regular)', 'var(--weight-medium)', 'var(--weight-strong)'])
    expect(block(tailwind, '@theme')).toMatch(/--font-weight-\*:\s*initial/)
    for (const heading of ['h1', 'h2', 'h3']) expect(block(elements, heading), heading).toContain('font-weight: var(--weight-strong)')
  })

  it('keeps every control, a link drawn as a button included, out of text selection', () => {
    const start = elements.indexOf(':where(button,')
    const rule = elements.slice(start, elements.indexOf('}', start))
    for (const selector of ['button', '[data-slot="button"]', '[role="button"]', '[role="tab"]', 'summary', 'nav a']) expect(rule, selector).toContain(selector)
    expect(rule).toContain('user-select: none')
  })

  it('styles one thin scrollbar everywhere: a transparent track and a thumb that darkens on hover', () => {
    // Chromium draws its native bar when scrollbar-width is set, so the standard properties are for other browsers only.
    expect(elements).toContain('@supports not selector(::-webkit-scrollbar) {\n  * { scrollbar-width: thin;')
    expect(elements).toContain('::-webkit-scrollbar { width: 8px; height: 8px; }')
    expect(elements).toContain('::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }')
    expect(elements).toContain('::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: var(--radius-pill); background: var(--color-border-strong) padding-box; }')
    expect(elements).toContain('::-webkit-scrollbar-thumb:hover { background-color: var(--color-muted); }')
  })
})

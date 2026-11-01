import { describe, expect, it } from 'vitest'
import columns from './page-columns.css?raw'

const rule = (selector: string) => {
  const start = columns.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return columns.slice(start, columns.indexOf('}', start))
}

const pages = import.meta.glob<string>('../**/*.vue', { query: '?raw', import: 'default', eager: true })

// Every class attribute that puts an element on .page-columns, with its file.
const columnElements = Object.entries(pages).flatMap(([file, source]) =>
  [...source.matchAll(/\bclass="([^"]*\bpage-columns\b[^"]*)"/g)].map(([, classes]) => ({ file, source, classes: classes.split(/\s+/) })))

describe('page columns', () => {
  it('packs cards as a masonry: two balanced columns read down the left one first', () => {
    expect(rule('.page-columns')).toMatch(/columns: 2 520px;/)
    expect(rule('.page-columns')).toMatch(/column-gap: var\(--space-4\);/)
    expect(rule('.page-columns > *')).toContain('break-inside: avoid')
    expect(columns).not.toMatch(/grid-template|display: grid/)
  })

  it('spaces cards with the gap token and lets a wide card span both columns', () => {
    expect(rule('.page-columns > * + *')).toContain('margin-block-start: var(--space-4)')
    expect(rule('.page-columns > .page-columns-wide')).toContain('column-span: all')
    expect(rule('.page-columns > .page-columns-wide:not(:last-child)')).toContain('margin-block-end: var(--space-4)')
    expect(rule('.page-columns > .page-columns-wide + *')).toContain('margin-block-start: 0')
  })

  it('is not turned back into a grid or flex box by a page using it', () => {
    expect(columnElements.length).toBeGreaterThanOrEqual(8)
    const overridden = columnElements.flatMap(({ file, source, classes }) => classes
      .filter(name => name !== 'page-columns' && (/^(grid|flex|inline-grid|inline-flex)$/.test(name)
        || new RegExp(`\\.${name}(?![\\w-])[^{]*\\{[^}]*\\bdisplay:`).test(source)))
      .map(name => `${file}: ${name}`))
    expect(overridden).toEqual([])
  })
})

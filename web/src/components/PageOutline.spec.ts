import { describe, expect, it } from 'vitest'
import source from './PageOutline.vue?raw'

// Layout is not measured in jsdom; these read the component's own rules (Jevons 11-08: 目录放在右边).
const style = source.slice(source.indexOf('<style'))
const rule = (selector: string) => style.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? ''

describe('the page outline placement', () => {
  it('hangs by the right edge of the window, clear of the scrollbar, never from the left', () => {
    const outline = rule('.page-outline')
    expect(outline).toMatch(/position: fixed/)
    expect(outline).toMatch(/right: calc\(max\(var\(--scrollbar-size\), 8px\) \+ 2px\)/)
    expect(outline).toMatch(/flex-direction: row-reverse/)
    expect(style).not.toMatch(/\.page-outline \{[^}]*\bleft:/)
  })

  it('opens its list leftwards from the rail', () => {
    expect(rule('.page-outline-list')).toMatch(/transform-origin: right top/)
    expect(rule('.page-outline-bar')).toMatch(/transform-origin: right/)
  })

  it('lifts the section being read as a card, with no side bar', () => {
    const reading = rule('.page-outline-item.is-reading')
    expect(reading).toMatch(/box-shadow/)
    expect(reading).not.toMatch(/border-left|inset/)
  })
})

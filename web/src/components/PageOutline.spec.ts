import { describe, expect, it } from 'vitest'
import source from './PageOutline.vue?raw'

// Layout is not measured in jsdom; these read the component's own rules
// (Jevons 11-08: 目录放在右边; 选中项只改文字颜色; 面板不像又一张卡片).
const style = source.slice(source.indexOf('<style'))
const rule = (selector: string) => style.match(new RegExp(`(?:^|\\n)${selector.replaceAll('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? ''

describe('the page outline', () => {
  it('hangs by the right edge of the window, clear of the scrollbar, never from the left', () => {
    const outline = rule('.page-outline')
    expect(outline).toMatch(/position: fixed/)
    expect(outline).toMatch(/right: calc\(max\(var\(--scrollbar-size\), 8px\) \+ 2px\)/)
    expect(outline).toMatch(/flex-direction: row-reverse/)
    expect(outline).not.toMatch(/\bleft:/)
  })

  it('is a ruler of ticks on a hairline, and the names open leftwards on the ticks\' rows', () => {
    expect(rule('.page-outline-rail::after')).toMatch(/width: 1px/)
    expect(rule('.page-outline-bar')).toMatch(/transform-origin: right/)
    const list = rule('.page-outline-list')
    expect(list).toMatch(/transform-origin: right top/)
    expect(list).toMatch(/grid-auto-rows: var\(--outline-row\)/)
    expect(rule('.page-outline-rail')).toMatch(/grid-auto-rows: var\(--outline-row\)/)
  })

  it('floats on faint glass with no edge or shadow, so it never reads as another card', () => {
    const list = rule('.page-outline-list')
    expect(list).not.toMatch(/border:|box-shadow/)
    expect(rule('.page-outline-list::before')).toMatch(/backdrop-filter: var\(--filter-dock\)/)
  })

  it('marks the section being read by its text alone: no box, no fill, no bar', () => {
    const reading = rule('.page-outline-item.is-reading')
    expect(reading).toMatch(/color: var\(--color-ink\)/)
    expect(reading).toMatch(/font-weight: var\(--weight-strong\)/)
    expect(reading).not.toMatch(/border|background|box-shadow|inset/)
    expect(rule('.page-outline-item')).toMatch(/color: var\(--color-muted\)/)
    expect(rule('.page-outline-item:hover')).toMatch(/color: var\(--color-ink-soft\)/)
  })
})

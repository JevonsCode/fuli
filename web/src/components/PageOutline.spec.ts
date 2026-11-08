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

  it('starts a little over a quarter down the window (28%), rising only as far as a long list needs, never under the top bar', () => {
    const outline = rule('.page-outline')
    expect(outline).toMatch(/--outline-row: 30px/)
    expect(outline).toMatch(/top: max\(var\(--outline-top-min\), min\(28dvh, calc\(100dvh - var\(--outline-height\) - var\(--outline-bottom\)\)\)\)/)
    expect(outline).toMatch(/--outline-top-min: calc\(76px \+ var\(--desktop-caption-top, 0px\)\)/)
    expect(outline).toMatch(/--outline-height: calc\(var\(--outline-rows, 3\) \* var\(--outline-row\) \+ 2 \* var\(--outline-pad\)\)/)
    expect(source).toMatch(/:style="\{ '--outline-rows': entries\.length \}"/)
  })

  it('is a ruler of ticks on a hairline, and the names open leftwards on the ticks\' rows', () => {
    expect(rule('.page-outline-rail::after')).toMatch(/width: 1px/)
    expect(rule('.page-outline-bar')).toMatch(/transform-origin: right/)
    const list = rule('.page-outline-list')
    expect(list).toMatch(/transform-origin: right top/)
    expect(list).toMatch(/grid-auto-rows: var\(--outline-row\)/)
    expect(rule('.page-outline-rail')).toMatch(/grid-auto-rows: var\(--outline-row\)/)
  })

  it('floats on faint glass with the shared glass edge, but no card fill or border', () => {
    const list = rule('.page-outline-list')
    expect(list).not.toMatch(/border:|background/)
    expect(list).toMatch(/box-shadow: var\(--shadow-glass\)/)
    const glass = rule('.page-outline-list::before')
    expect(glass).toMatch(/backdrop-filter: var\(--filter-dock\)/)
    expect(glass).toMatch(/background: var\(--surface-dock\)/)
  })

  it('marks the section being read by its text alone: no box, no fill, no bar', () => {
    const reading = rule('.page-outline-item.is-reading')
    expect(reading).toMatch(/color: var\(--color-ink\)/)
    expect(reading).not.toMatch(/font-weight/)
    expect(reading).not.toMatch(/border|background|box-shadow|inset/)
    expect(rule('.page-outline-item')).toMatch(/color: var\(--color-muted\)/)
    expect(rule('.page-outline-item:hover')).toMatch(/color: var\(--color-ink-soft\)/)
  })
})

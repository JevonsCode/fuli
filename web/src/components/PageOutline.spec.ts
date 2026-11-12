import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PageOutline from './PageOutline.vue'
import source from './PageOutline.vue?raw'

// Layout is not measured in jsdom; these read the component's own rules
// (Jevons 11-08: 目录放在右边; 选中项只改文字颜色; 面板不像又一张卡片).
const style = source.slice(source.indexOf('<style'))
const rule = (selector: string) => style.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.()|:]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? ''
const open = (part: string) => rule(`.page-outline:is(:hover, :has(:focus-visible)) ${part}`)

describe('the page outline look', () => {
  it('hangs by the right edge of the window, clear of the scrollbar, never from the left', () => {
    const outline = rule('.page-outline')
    expect(outline).toMatch(/position: fixed/)
    expect(outline).toMatch(/right: calc\(max\(var\(--scrollbar-size\), 8px\) \+ 2px\)/)
    expect(outline).not.toMatch(/\bleft:/)
  })

  it('starts a little over a quarter down the window (28%), rising only as far as a long list needs, never under the top bar', () => {
    const outline = rule('.page-outline')
    expect(outline).toMatch(/--outline-row: clamp\(16px, .*, 30px\)/)
    expect(outline).toMatch(/top: max\(var\(--outline-top-min\), min\(28dvh, calc\(100dvh - var\(--outline-height\) - var\(--outline-bottom\)\)\)\)/)
    expect(outline).toMatch(/--outline-top-min: calc\(76px \+ var\(--desktop-caption-top, 0px\)\)/)
    expect(outline).toMatch(/--outline-height: calc\(var\(--outline-rows, 3\) \* var\(--outline-row\) \+ 2 \* var\(--outline-pad\)\)/)
  })

  it('is a glass capsule of dots in the page margin; only the capsule takes the pointer until it opens', () => {
    expect(rule('.page-outline')).toMatch(/pointer-events: none/)
    expect(rule('.page-outline')).toMatch(/--outline-capsule: clamp\(14px, calc\(2\.4vw - 10px\), 20px\)/)
    const capsule = rule('.page-outline-capsule')
    expect(capsule).toMatch(/width: var\(--outline-capsule\)/)
    expect(capsule).toMatch(/pointer-events: auto/)
    expect(rule('.page-outline-item')).toMatch(/pointer-events: none/)
    expect(open('.page-outline-item')).toMatch(/pointer-events: auto/)
    expect(rule('.page-outline-dot')).toMatch(/width: var\(--outline-capsule\)/)
  })

  it('shows no outline when even the shortest rows would not fit the window', async () => {
    const height = window.innerHeight
    try {
      // 12 sections need 12 x 16 + 12 = 204px between the top bar (76) and the bottom margin (32).
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 311 })
      const labels = Array.from({ length: 12 }, (_, index) => `合成 ${index}`)
      expect(await outlineOf(longPage(labels))).toBeNull()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 312 })
      expect(await outlineOf(longPage(labels))).not.toBeNull()
      // In the desktop client the strip under the window buttons takes its height from the same room.
      mounted.splice(0).forEach(wrapper => wrapper.unmount())
      document.documentElement.style.setProperty('--desktop-caption-top', '40px')
      expect(await outlineOf(longPage(labels))).toBeNull()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 352 })
      expect(await outlineOf(longPage(labels))).not.toBeNull()
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
      document.documentElement.style.removeProperty('--desktop-caption-top')
    }
  })

  it('keeps a long list inside the window by shortening its rows, down to one line of the names', () => {
    const root = rule('.page-outline')
    expect(root).toMatch(/--outline-row: clamp\(16px, calc\(\(100dvh - var\(--outline-top-min\) - var\(--outline-bottom\) - 2 \* var\(--outline-pad\)\) \/ var\(--outline-rows, 3\)\), 30px\)/)
    expect(root).toMatch(/--outline-pill: min\(14px, calc\(var\(--outline-row\) - 4px\)\)/)
  })

  it('floats on the dock\'s frosted glass with the shared glass edge, the backdrop declared -webkit- first', () => {
    const glass = rule('.page-outline-glass, .page-outline-capsule')
    expect(glass).toMatch(/background: var\(--surface-dock\)/)
    expect(glass).toMatch(/-webkit-backdrop-filter: var\(--filter-dock\); backdrop-filter: var\(--filter-dock\)/)
    expect(glass).toMatch(/box-shadow: var\(--shadow-glass\)/)
    expect(style).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/)
    expect(rule('.page-outline-glass')).not.toMatch(/border:/)
  })

  it('opens leftwards from the capsule with compositor-only motion, waiting for the pointer to rest', () => {
    const panel = rule('.page-outline-glass')
    expect(panel).toMatch(/transform-origin: right center/)
    expect(panel).toMatch(/visibility: hidden/)
    expect(open('.page-outline-glass')).toMatch(/visibility: visible/)
    expect(open('.page-outline-name')).toMatch(/opacity: 1/)
    expect(rule('.page-outline')).toMatch(/--outline-open-delay: var\(--motion-intent\)/)
    expect(rule('.page-outline:has(:focus-visible)')).toMatch(/--outline-open-delay: 0s/)
    const transitions = [...style.matchAll(/transition: ([^;]+);/g)].flatMap(([, list]) => list!.split(/,(?![^(]*\))/).map(item => item.trim().split(' ')[0]))
    expect(new Set(transitions)).toEqual(new Set(['visibility', 'opacity', 'scale', 'color', 'background-color', 'translate', 'none']))
  })

  it('marks the section being read by text colour alone, and by the ink pill in the capsule', () => {
    const reading = rule('.page-outline-item.is-reading')
    expect(reading).toMatch(/color: var\(--color-ink\)/)
    expect(reading).not.toMatch(/font-weight|border|background|box-shadow|inset/)
    expect(rule('.page-outline-item')).toMatch(/color: var\(--color-muted\)/)
    expect(rule('.page-outline-item:hover')).toMatch(/color: var\(--color-ink-soft\)/)
    const marker = rule('.page-outline-marker')
    expect(marker).toMatch(/background: var\(--color-ink\)/)
    expect(marker).toMatch(/translate: 0 calc\(var\(--outline-reading, 0\) \* var\(--outline-row\)\)/)
  })

  it('keeps the names open on a window with room beside the page, and hides below 760px', () => {
    expect(style).toMatch(/@media \(min-width: 2400px\) \{[\s\S]*\.page-outline-glass \{ opacity: 1; visibility: visible/)
    expect(style).toMatch(/@media \(max-width: 760px\) \{ \.page-outline \{ display: none; \} \}/)
  })
})

// A scrolling page of sections, its geometry given by hand (jsdom lays nothing out).
function longPage(labels: string[], scrollHeight = 3000) {
  const scroller = document.createElement('div')
  scroller.style.overflowY = 'auto'
  Object.defineProperties(scroller, { scrollHeight: { value: scrollHeight }, clientHeight: { value: 600 } })
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  const content = document.createElement('div')
  const sections = labels.map((label, index) => {
    const section = document.createElement('section')
    const heading = document.createElement('h2')
    heading.textContent = label
    heading.getBoundingClientRect = () => ({ top: index * 1000 - scroller.scrollTop }) as DOMRect
    section.scrollIntoView = vi.fn()
    section.append(heading)
    return section
  })
  content.append(...sections)
  scroller.append(content)
  document.body.append(scroller)
  return { scroller, content, sections }
}

const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { run(0); return 0 })
})
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function outlineOf(page: ReturnType<typeof longPage>) {
  mounted.push(mount(PageOutline, { props: { content: page.content }, attachTo: document.body }))
  await nextTick()
  return document.querySelector<HTMLElement>('[data-page-outline]')
}
const items = () => [...document.querySelectorAll<HTMLElement>('[data-page-outline-item]')]

describe('the page outline', () => {
  it('lists every section, one dot each, and marks the one being read', async () => {
    const nav = await outlineOf(longPage(['模型', '连接', '数据']))
    expect(nav?.getAttribute('aria-label')).toBeTruthy()
    expect(items().map(item => item.textContent?.trim())).toEqual(['模型', '连接', '数据'])
    expect(document.querySelectorAll('.page-outline-dot')).toHaveLength(3)
    expect(items().map(item => item.getAttribute('aria-current'))).toEqual(['location', null, null])
    expect(nav?.style.getPropertyValue('--outline-reading')).toBe('0')
  })

  it('moves the mark as the page scrolls, and puts no name over the page', async () => {
    const page = longPage(['模型', '连接', '数据'])
    const nav = await outlineOf(page)
    page.scroller.scrollTop = 1000
    page.scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(items().map(item => item.getAttribute('aria-current'))).toEqual([null, 'location', null])
    expect(items()[0]!.classList).toContain('is-read')
    expect(nav?.style.getPropertyValue('--outline-reading')).toBe('1')
    // Nothing but the capsule shows at rest: a name beside it would sit over the cards' own actions.
    expect(document.querySelector('[data-page-outline-here]')).toBeNull()
  })

  it('scrolls to a section when its name is chosen', async () => {
    const page = longPage(['模型', '连接', '数据'])
    await outlineOf(page)
    items()[2]!.click()
    expect(page.sections[2]!.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('shows nothing on a page too short to need it', async () => {
    expect(await outlineOf(longPage(['模型', '连接'], 1000))).toBeNull()
  })
})

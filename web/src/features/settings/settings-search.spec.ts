import { describe, expect, it } from 'vitest'
import { filterSettings } from './settings-search'

function page() {
  const root = document.createElement('div')
  root.innerHTML = `
    <section class="settings-card" data-card="behavior">
      <h3>Behaviour</h3>
      <label class="setting-row" data-row="capture">Capture knowledge automatically</label>
      <label class="setting-row" data-row="language">Interface language English</label>
    </section>
    <details class="settings-card" data-card="ports">
      <summary>Ports</summary>
      <label class="setting-row" data-row="console">Console port</label>
    </details>
    <details class="settings-card" data-card="notifications" open>
      <summary>Notifications</summary>
      <p>Desktop alerts when an Agent asks you</p>
    </details>`
  return root
}
const hidden = (root: HTMLElement, selector: string) => root.querySelector(selector)!.hasAttribute('data-search-hidden')

describe('filterSettings', () => {
  it('keeps only matching rows inside a card whose title does not match', () => {
    const root = page()
    expect(filterSettings(root, 'language')).toBe(1)
    expect(hidden(root, '[data-card="behavior"]')).toBe(false)
    expect(hidden(root, '[data-row="language"]')).toBe(false)
    expect(hidden(root, '[data-row="capture"]')).toBe(true)
    expect(hidden(root, '[data-card="ports"]')).toBe(true)
  })

  it('opens a matching collapsed card, ignores case, and closes it again when cleared', () => {
    const root = page()
    const ports = root.querySelector<HTMLDetailsElement>('[data-card="ports"]')!
    expect(filterSettings(root, 'CONSOLE')).toBe(1)
    expect(ports.open).toBe(true)
    expect(filterSettings(root, '')).toBe(3)
    expect(ports.open).toBe(false)
    expect(root.querySelectorAll('[data-search-hidden]')).toHaveLength(0)
  })

  it('keeps a whole card when the title or only non-row text matches, and leaves cards the person opened open', () => {
    const root = page()
    expect(filterSettings(root, 'behaviour')).toBe(1)
    expect(hidden(root, '[data-row="capture"]')).toBe(false)
    expect(filterSettings(root, 'desktop alerts')).toBe(1)
    expect(filterSettings(root, '')).toBe(3)
    expect(root.querySelector<HTMLDetailsElement>('[data-card="notifications"]')!.open).toBe(true)
  })

  it('reports no match without hiding the page structure', () => {
    const root = page()
    expect(filterSettings(root, 'nothing like this')).toBe(0)
  })
})

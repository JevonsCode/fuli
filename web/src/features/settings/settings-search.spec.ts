import { describe, expect, it } from 'vitest'
import { setLocale, t } from '@/i18n'
import { filterSettings, linkedCard, settingSearchTerm } from './settings-search'

function page() {
  const root = document.createElement('div')
  root.innerHTML = `
    <section class="settings-card" data-card="behavior">
      <h2 data-slot="card-title">Behaviour</h2>
      <label class="setting-row" data-row="capture">Capture knowledge automatically</label>
      <label class="setting-row" data-row="language">Interface language English</label>
    </section>
    <section class="settings-card" data-card="ports" id="ports">
      <h2 data-slot="card-title">Ports</h2>
      <h3 class="ui-group-label">Personal</h3>
      <label class="setting-row" data-row="console">Console port</label>
    </section>
    <section class="settings-card" data-card="notifications">
      <h2 data-slot="card-title">Notifications</h2>
      <p id="needs-person">Desktop alerts when an Agent asks you</p>
    </section>`
  document.body.append(root)
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
    root.remove()
  })

  it('ignores case and shows every card again when cleared', () => {
    const root = page()
    expect(filterSettings(root, 'CONSOLE')).toBe(1)
    expect(hidden(root, '[data-card="ports"]')).toBe(false)
    expect(filterSettings(root, '')).toBe(3)
    expect(root.querySelectorAll('[data-search-hidden]')).toHaveLength(0)
    root.remove()
  })

  it('keeps a whole card when its title or only non-row text matches', () => {
    const root = page()
    expect(filterSettings(root, 'behaviour')).toBe(1)
    expect(hidden(root, '[data-row="capture"]')).toBe(false)
    expect(filterSettings(root, 'desktop alerts')).toBe(1)
    expect(hidden(root, '[data-card="notifications"]')).toBe(false)
    root.remove()
  })

  it('reports no match without hiding the page structure', () => {
    const root = page()
    expect(filterSettings(root, 'nothing like this')).toBe(0)
    root.remove()
  })
})

describe('linkedCard', () => {
  it('finds the card holding a #hash target, or the first card a search left', () => {
    const root = page()
    expect(linkedCard(root, '#needs-person')?.dataset.card).toBe('notifications')
    expect(linkedCard(root, '#ports')?.dataset.card).toBe('ports')
    expect(linkedCard(root, '#no-such-card')).toBeNull()
    filterSettings(root, 'console')
    expect(linkedCard(root, '')?.dataset.card).toBe('ports')
    root.remove()
  })
})

describe('settingSearchTerm', () => {
  it('turns every linked setting key into its label in the current language', () => {
    setLocale('zh-CN', { persist: false })
    for (const key of ['capture', 'notifications', 'refresh', 'launchers', 'lanAccess', 'ports', 'runtimeMode']) {
      const label = settingSearchTerm(key, t)
      expect(label, key).not.toMatch(/^settings\./)
      expect(label.length, key).toBeGreaterThan(1)
    }
    expect(settingSearchTerm('ports', t)).toBe('服务端口')
    expect(settingSearchTerm('unknown', t)).toBe('')
    expect(settingSearchTerm(['ports'], t)).toBe('')
  })
})

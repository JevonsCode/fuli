import { describe, expect, it } from 'vitest'
import { setLocale, t } from '@/i18n'
import pageStyles from '../../styles.css?raw'
import settingsPage from '@/pages/SettingsPage.vue?raw'

// rec#102 (macOS 0.25.0 walk): English labels were cut where widths had been sized to Chinese.
describe('English layout at the client\'s narrow width', () => {
  it('lets the directory filters grow to an English label instead of a fixed Chinese width', () => {
    for (const id of ['type', 'quadrant', 'profile', 'status']) {
      const rule = pageStyles.slice(pageStyles.indexOf(`[data-select-id="knowledge-${id}-filter"] {`))
      expect(rule.slice(0, rule.indexOf('}')), id).toMatch(/\{ min-width: \d+px; max-width: 220px; $/)
    }
    expect(pageStyles).not.toMatch(/#knowledge-(type|quadrant|profile)-filter \{ max-width/)
  })

  it('wraps the graph count under the view tabs instead of cutting 「Relationship graph」', () => {
    expect(pageStyles).toContain('.knowledge-view-heading { min-height: 42px; display: flex; flex-wrap: wrap;')
    expect(pageStyles).toContain('.knowledge-view-heading > .knowledge-mode-tabs { min-width: min(100%, max-content); }')
  })

  it('moves the settings search under the tabs when both no longer fit', () => {
    expect(settingsPage).toContain('.settings-tabbar > :first-child { flex: 1 0 auto; max-width: 100%; }')
  })

  it('says one thing needs you in the singular', () => {
    setLocale('en-US', { persist: false })
    expect(t('doctor.summary', { count: 1 })).toBe('1 thing needs you')
    expect(t('doctor.summary', { count: 3 })).toBe('3 things need you')
    setLocale('zh-CN', { persist: false })
    expect(t('doctor.summary', { count: 1 })).toBe('有 1 件事需要你')
  })
})

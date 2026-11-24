import { describe, expect, it } from 'vitest'
import { setLocale, t } from '@/i18n'
import pageStyles from '../../styles.css?raw'
import settingsPage from '@/pages/SettingsPage.vue?raw'
import settingsTabsShell from '@/features/settings/SettingsTabsShell.vue?raw'

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

  it('keeps the settings page from scrolling sideways at 460pt and moves the search under the tabs', () => {
    expect(settingsPage).toContain('.settings-content { grid-template-columns: minmax(0, 1fr); }')
    // The tab row is the tabs shell's (layout A, which narrow windows always show).
    expect(settingsTabsShell).toContain('@media (max-width: 520px) { .settings-tabbar :deep([role="tab"]) { padding-inline: 8px; } }')
    // min(100%, max-content), not flex-shrink 0: a max-content floor widened the whole settings column (rec#102 re-test).
    expect(settingsTabsShell).toContain('.settings-tabbar > :first-child { flex: 1 1 auto; min-width: min(100%, max-content); }')
  })

  it('says one thing needs you in the singular', () => {
    setLocale('en-US', { persist: false })
    expect(t('doctor.summary', { count: 1 })).toBe('1 thing needs you')
    expect(t('doctor.summary', { count: 3 })).toBe('3 things need you')
    setLocale('zh-CN', { persist: false })
    expect(t('doctor.summary', { count: 1 })).toBe('有 1 件事需要你')
  })
})

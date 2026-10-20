import { describe, expect, it } from 'vitest'

// Pages compose the design system instead of hand-building controls. These
// counts may only go down: lower them in the same change that rebuilds a page
// on Button / UiIconButton / UiToggle or a shadcn-vue component. 2026-10-20:
// 43 / 3 after action buttons moved to the shared Button; 42 / 3 after the
// Agent profile tabs moved to shadcn-vue Tabs. The rest are controls
// deliberately deferred to their own components (tabs, toggle groups, list
// rows, cards, pickers), and a few are still actions waiting to move, such as
// the preferences page's "show more".
const BASELINE = { button: 42, switch: 3 }
const templates = import.meta.glob<string>('../**/*.vue', { query: '?raw', import: 'default', eager: true })
const outsideDesignSystem = Object.entries(templates).filter(([file]) => !file.startsWith('./')).map(([, source]) => source)
// The classes the shared Button replaced. A template is where a class gets
// used, so checking templates (and their <style> blocks) keeps one button system.
const LEGACY_BUTTON_CLASS = /\b(ui-button|ui-icon-button|quiet-button|primary-button|primary-action|secondary-action|management-action|toolbar-action)\b(?!-)/

describe('design system adoption', () => {
  it('never adds hand-built buttons or switches outside web/src/ui', () => {
    expect(outsideDesignSystem.length).toBeGreaterThan(50)
    const button = outsideDesignSystem.reduce((sum, source) => sum + (source.match(/<button\b/g)?.length ?? 0), 0)
    const toggle = outsideDesignSystem.reduce((sum, source) => sum + (source.match(/role="switch"/g)?.length ?? 0), 0)
    expect(button, 'use Button (components/ui/button) or UiIconButton instead of a new <button>').toBeLessThanOrEqual(BASELINE.button)
    expect(toggle, 'use Switch (components/ui/switch) or UiToggle instead of a new switch').toBeLessThanOrEqual(BASELINE.switch)
  })

  it('keeps one button system: no legacy button classes anywhere', () => {
    const offenders = Object.entries(templates).filter(([, source]) => LEGACY_BUTTON_CLASS.test(source)).map(([file]) => file)
    expect(offenders).toEqual([])
  })
})

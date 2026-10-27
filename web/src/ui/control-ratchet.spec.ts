import { describe, expect, it } from 'vitest'

// Pages compose the design system instead of hand-building controls. These
// counts may only go down: lower them in the same change that rebuilds a page
// on Button / UiIconButton / UiToggle or a shadcn-vue component. 2026-10-20:
// 43 / 3 after action buttons moved to the shared Button; 42 / 3 after the
// Agent profile tabs moved to shadcn-vue Tabs; 36 / 3 after the knowledge view tabs
// moved to Tabs and the preferences page's "show more" to Button, and 编排's
// rows became cards (quick look on the shared Button, status on UiSegmented).
// 28 / 3 after Bole's views moved to Tabs and its role filter to UiSegmented, and
// Tonborg's filter moved to UiSegmented and its feedback votes to Button;
// 27 / 3 after the task board's drag handle moved to Button (2026-10-21).
// The rest are controls deliberately deferred to their own components (tabs,
// toggle groups, list rows, cards, pickers).
const BASELINE = { button: 27, switch: 3 }
const HEAVY_WEIGHT_BASELINE = 122
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

  // The type scale has three weights (theme/base.css): 400, 500 for controls,
  // 600 for headings. Older page CSS still asks for 650-750, which renders as
  // bold and flattens the hierarchy. This count may only go down: move a rule
  // to var(--weight-strong) or var(--weight-medium) when a page is touched.
  // 2026-10-28: 122 after the shared components moved to the scale (the brand
  // wordmark keeps its 700).
  it('never adds a weight heavier than the type scale', () => {
    const styles = import.meta.glob<string>(['../**/*.vue', '../**/*.css', '../../styles.css'], { query: '?raw', import: 'default', eager: true })
    const heavy = Object.values(styles).reduce((sum, source) => sum + (source.match(/font-weight:\s*(6[1-9]\d|[7-9]\d\d|bold)/g)?.length ?? 0), 0)
    expect(heavy, 'use var(--weight-strong) (600) or var(--weight-medium) (500)').toBeLessThanOrEqual(HEAVY_WEIGHT_BASELINE)
  })
})

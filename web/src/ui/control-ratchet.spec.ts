import { describe, expect, it } from 'vitest'

// Pages compose the design system instead of hand-building controls. These
// counts may only go down: lower them in the same change that rebuilds a page
// on Button / UiIconButton / UiToggle. 2026-10-20 baseline: 43 / 3, after every
// action button moved to the shared shadcn-vue Button; the rest are tabs,
// toggles, list rows, cards and pickers waiting for their own components.
const BASELINE = { button: 43, switch: 3 }
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
    expect(toggle, 'use UiToggle instead of a new switch').toBeLessThanOrEqual(BASELINE.switch)
  })

  it('keeps one button system: no legacy button classes anywhere', () => {
    const offenders = Object.entries(templates).filter(([, source]) => LEGACY_BUTTON_CLASS.test(source)).map(([file]) => file)
    expect(offenders).toEqual([])
  })
})

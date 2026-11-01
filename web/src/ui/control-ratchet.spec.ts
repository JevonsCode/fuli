import { describe, expect, it } from 'vitest'

// Pages compose the design system instead of hand-building controls. These
// counts may only go down: lower them in the same change that rebuilds a page
// on Button / UiIconButton or a shadcn-vue component. 2026-10-20:
// 43 / 3 after action buttons moved to the shared Button; 42 / 3 after the
// Agent profile tabs moved to shadcn-vue Tabs; 36 / 3 after the knowledge view tabs
// moved to Tabs and the preferences page's "show more" to Button, and 编排's
// rows became cards (quick look on the shared Button, status on UiSegmented).
// 28 / 3 after Bole's views moved to Tabs and its role filter to UiSegmented, and
// Tonborg's filter moved to UiSegmented and its feedback votes to Button;
// 27 / 3 after the task board's drag handle moved to Button (2026-10-21).
// 27 / 0 after UiToggle and the Agent policy checkboxes moved to the shared
// Switch (2026-10-28).
// The rest are controls deliberately deferred to their own components (tabs,
// toggle groups, list rows, cards, pickers).
const BASELINE = { button: 27, switch: 0 }
const HEAVY_WEIGHT_BASELINE = 114
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
    expect(toggle, 'use Switch (components/ui/switch) instead of a new switch').toBeLessThanOrEqual(BASELINE.switch)
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
  // wordmark keeps its 700). 114 after the wide-layouts pass moved the Agent
  // card, 知识整理 and 项目资料 rules to the tokens.
  it('never adds a weight heavier than the type scale', () => {
    const styles = import.meta.glob<string>(['../**/*.vue', '../**/*.css', '../../styles.css'], { query: '?raw', import: 'default', eager: true })
    const heavy = Object.values(styles).reduce((sum, source) => sum + (source.match(/font-weight:\s*(6[1-9]\d|[7-9]\d\d|bold)/g)?.length ?? 0), 0)
    expect(heavy, 'use var(--weight-strong) (600) or var(--weight-medium) (500)').toBeLessThanOrEqual(HEAVY_WEIGHT_BASELINE)
  })

  // Controls take their height from the size scale (theme/base.css,
  // ui/control-size.spec.ts): a page picks size sm | md | lg and never sizes a
  // control's height by hand, so the controls of a row stay one height
  // (Jevons 11-01). A page rule may still use the tokens themselves; a glyph
  // under 20px (a radio's dot, a chevron) is not a control's box.
  it('never hand-sizes a control height on a page', () => {
    const styles = import.meta.glob<string>(['../**/*.vue', '../**/*.css', '../../styles.css', '!../components/ui/**', '!../styles/theme/**'],
      { query: '?raw', import: 'default', eager: true })
    const offenders = Object.entries(styles).flatMap(([file, source]) => handSizedControls(source).map(rule => `${file.replace(/^\.\.\//, '')} ${rule}`))
    expect(Object.keys(styles).length, 'the scan reads page styles').toBeGreaterThan(50)
    expect(offenders.filter(rule => !HAND_SIZED_ALLOWED.some(allowed => rule.startsWith(allowed)))).toEqual([])
    // Every exception still exists, so the list only shrinks.
    for (const allowed of HAND_SIZED_ALLOWED) expect(offenders.some(rule => rule.startsWith(allowed)), allowed).toBe(true)
  })

  it('never gives a field or picker a height utility in a template', () => {
    const offenders = Object.entries(templates).filter(([file]) => !file.startsWith('../components/ui/'))
      .flatMap(([file, source]) => [...source.matchAll(/<(Input|OptionSelect|OptionCombobox|SelectTrigger|UiSegmented|UiIconButton)\b[^>]*\bclass="([^"]*)"/g)]
        .filter(([, , classes]) => /(?:^|\s)!?(?:min-)?h-(?!control-|auto\b|full\b)\S+/.test(classes!))
        .map(([tag]) => `${file} ${tag!.slice(0, 60)}`))
    expect(offenders, 'pass size="sm" | "md" | "lg" instead').toEqual([])
  })
})

// Controls of their own kind whose height is not a row control's (a card's
// corner handle, a choice card, a To: chip row's bare search, a composer's
// borderless textarea, the language switcher's tiny toggle).
const HAND_SIZED_ALLOWED = [
  'features/employees/EmployeeTaskBoard.vue .employee-all-projects-drag-handle',
  'features/preferences/PreferenceConflictDialog.vue .conflict-resolution-options > button',
  'features/roundtables/RoundtableNewConversation.vue .rt-new-search',
  'features/roundtables/RoundtableComposer.vue .rt-compose-input',
  'styles/vue.css .locale-switcher button',
]
const CONTROL_SELECTOR = /\binput\b(?!\[type=["']?(?:checkbox|radio))|\bselect\b|\btextarea\b|\bbutton\b|\[data-slot=["']?(?:button|input|select-trigger|option-select|option-combobox|combobox-anchor)|-(?:search|select|input|trigger|picker)\b|-picker\s*>\s*summary/
const PIXEL_HEIGHT = /(?<![-\w])(?:min-)?height\s*:\s*(?:[2-9]\d|\d{3,})(?:\.\d+)?px/

/** Innermost rules of a stylesheet (or a component's style blocks) that give a control a literal pixel height. */
function handSizedControls(source: string) {
  const css = (source.includes('<template') ? [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(([, body]) => body).join('\n') : source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => [selector!.trim().split('\n').at(-1)!.trim(), body!] as const)
    .filter(([selector, body]) => CONTROL_SELECTOR.test(selector) && PIXEL_HEIGHT.test(body))
    .map(([selector]) => selector)
}

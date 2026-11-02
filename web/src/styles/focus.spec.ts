import { describe, expect, it } from 'vitest'
import { FIELD_FOCUS, FIELD_FOCUS_WITHIN, FIELD_LOOK } from '@/components/ui/field-look'
import elements from './theme/elements.css?raw'

// Text fields never keep the browser's focus ring: a field's focus is the
// strong hairline border plus a soft neutral ring, in the shared styles and
// the shared field look, not per page. Buttons and links keep the keyboard
// focus-visible outline.
const rule = (selector: string) => {
  const start = elements.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`missing ${selector}`)
  return elements.slice(start, elements.indexOf('}', start))
}

describe('text field focus', () => {
  it('draws a field focus with the strong border and a soft neutral ring, no browser outline', () => {
    const focus = rule(':where(input:not([type=checkbox]):not([type=radio]), textarea, select):focus')
    expect(focus).toContain('border-color: var(--color-border-strong)')
    expect(focus).toContain('var(--color-surface-hover)')
    expect(focus).toContain('outline: none')
    expect(focus).not.toContain('var(--color-accent)')
  })

  it('keeps the keyboard focus-visible outline on buttons and links', () => {
    const visible = rule(':where(button, a, input, select, textarea, summary, [tabindex]):focus-visible')
    expect(visible).toContain('outline: 2px solid var(--color-accent)')
  })

  it('gives every shared field the same subtle look on focus, click or keyboard', () => {
    expect(FIELD_LOOK).toContain('outline-none')
    expect(FIELD_FOCUS).toContain('focus:border-border-strong')
    expect(FIELD_FOCUS).toContain('focus:ring-4')
    expect(FIELD_FOCUS).toContain('focus:ring-accent')
    expect(FIELD_FOCUS).not.toContain('focus-visible:')
    expect(FIELD_FOCUS_WITHIN).toContain('focus-within:border-border-strong')
    expect(FIELD_FOCUS_WITHIN).toContain('focus-within:ring-accent')
  })
})

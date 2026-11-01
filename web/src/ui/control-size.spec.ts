import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { h } from 'vue'

import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import type { ControlSize } from '@/components/ui/control-size'
import { Input } from '@/components/ui/input'
import { OptionSelect } from '@/components/ui/select'
import primitives from '@/styles/primitives.css?raw'
import base from '@/styles/theme/base.css?raw'
import elements from '@/styles/theme/elements.css?raw'
import tailwind from '@/styles/theme/tailwind.css?raw'
import UiIconButton from './UiIconButton.vue'
import UiSegmented from './UiSegmented.vue'

// One control size scale (theme/base.css, docs/console-design.md): every
// control takes size sm | md | lg, default md, and is exactly that height, so a
// row of controls of one size lines up (Jevons 11-01).
const SIZES: ControlSize[] = ['sm', 'md', 'lg']
const HEIGHT_PX: Record<ControlSize, number> = { sm: 30, md: 36, lg: 44 }
const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function rendered(node: ReturnType<typeof h>) {
  const wrapper = mount({ render: () => node }, { attachTo: document.body })
  mounted.push(wrapper)
  return wrapper
}

// What each control's box is, given a size (undefined = the default).
const CONTROLS: Record<string, (size?: ControlSize) => HTMLElement> = {
  'Button': size => rendered(h(Button, { size }, () => 'Save')).get('button').element as HTMLElement,
  'Button icon': size => rendered(h(Button, { size: size ? `icon-${size}` : 'icon' }, () => '+')).get('button').element as HTMLElement,
  'UiIconButton': size => rendered(h(UiIconButton, { icon: 'refresh', label: 'Refresh', size })).get('button').element as HTMLElement,
  'Input': size => rendered(h(Input, { size })).get('input').element as HTMLElement,
  'Input search': size => rendered(h(Input, { size, type: 'search' })).get('input').element as HTMLElement,
  'OptionSelect': size => rendered(h(OptionSelect, { modelValue: 'a', options, label: 'Pick', size })).get('[data-slot=select-trigger]').element as HTMLElement,
  'OptionCombobox': size => rendered(h(OptionCombobox, { modelValue: 'a', options, label: 'Pick', size })).get('[data-slot=combobox-anchor]').element as HTMLElement,
  'OptionCombobox multiple': size => rendered(h(OptionCombobox, { modelValue: ['a'], options, label: 'Pick', multiple: true, size })).get('[data-size]').element as HTMLElement,
  'UiSegmented': size => rendered(h(UiSegmented, { modelValue: 'a', options, label: 'View', size })).get('.ui-segmented').element as HTMLElement,
}

// The height utility a control's classes resolve to.
function heightToken(element: HTMLElement) {
  return [...element.classList].map(name => name.match(/^(?:min-h|h|size)-(control|square)-(sm|md|lg)$/)?.[2]).find(Boolean)
}

function cssValue(css: string, name: string) {
  return css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1]?.trim()
}

describe('control size scale', () => {
  it('defines a complete set for every size', () => {
    for (const size of SIZES) {
      expect(cssValue(base, `--control-height-${size}`), size).toBe(`${HEIGHT_PX[size]}px`)
      for (const token of ['square', 'padding', 'text'].map(part => `--control-${part}-${size}`)
        .concat(['padding', 'text'].map(part => `--field-${part}-${size}`))) {
        expect(cssValue(base, token), token).toBeTruthy()
      }
      expect(cssValue(base, `--control-square-${size}`)).toBe(`var(--control-height-${size})`)
      expect(tailwind).toContain(`--spacing-control-${size}: var(--control-height-${size});`)
      expect(tailwind).toContain(`--spacing-square-${size}: var(--control-square-${size});`)
    }
    expect(cssValue(base, '--control-height')).toBe('var(--control-height-md)')
  })

  it('gives every control the same height token for each size, md by default', () => {
    for (const [name, render] of Object.entries(CONTROLS)) {
      if (name === 'UiSegmented') continue
      expect(heightToken(render()), `${name} default`).toBe('md')
      for (const size of SIZES) expect(heightToken(render(size)), `${name} ${size}`).toBe(size)
    }
  })

  it('keeps the segmented track exactly the control height of its size', () => {
    expect(CONTROLS.UiSegmented!().dataset.size).toBe('md')
    for (const size of SIZES) expect(CONTROLS.UiSegmented!(size).dataset.size).toBe(size)
    expect(primitives).toMatch(/\.ui-segmented \{[^}]*--segmented-height: var\(--control-height-md\)[^}]*height: var\(--segmented-height\)/)
    for (const size of ['sm', 'lg']) {
      expect(primitives).toContain(`.ui-segmented[data-size=${size}] { --segmented-height: var(--control-height-${size});`)
    }
  })

  it('maps the upstream button size names onto md', () => {
    const md = CONTROLS.Button!('md').className
    expect(rendered(h(Button, { size: 'default' }, () => 'Save')).get('button').element.className).toBe(md)
    expect(rendered(h(Button, { size: 'icon' }, () => '+')).get('button').element.className)
      .toBe(CONTROLS['Button icon']!('md').className)
  })

  it('sizes a raw field at exactly the md height: its border, padding and one line fit inside 36px', () => {
    const rule = elements.slice(elements.indexOf('/* Text inputs'))
    expect(rule).toMatch(/min-height: var\(--control-height-md\); padding: 6px var\(--field-padding-md\)/)
    expect(rule).toMatch(/font-size: var\(--field-text-md\); line-height: 1\.5/)
    expect(cssValue(base, '--field-text-md')).toBe('var(--text-body)')
    expect(cssValue(base, '--text-body')).toBe('14px')
    const natural = 2 * 1 + 2 * 6 + 14 * 1.5
    expect(natural).toBeLessThanOrEqual(HEIGHT_PX.md)
  })
})

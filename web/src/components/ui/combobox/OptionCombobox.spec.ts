import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { setLocale } from '@/i18n'
import primitives from '@/styles/primitives.css?raw'
import tailwindTheme from '@/styles/theme/tailwind.css?raw'
import type { SelectOption } from '../select/option'
import { OptionCombobox } from '.'

const projects: SelectOption[] = [
  { value: 'alpha', label: 'Alpha 项目', meta: '#alpha' },
  { value: 'beta', label: 'Beta 项目' },
  { value: 'gamma', label: 'Gamma 项目' },
  { value: 'delta', label: 'Delta 项目', disabled: true },
]

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function mountCombobox<V extends string | string[]>(initial: V, props: Record<string, unknown> = {}) {
  const value = ref(initial) as { value: V }
  const Harness = defineComponent(() => () => h(OptionCombobox<V>, {
    modelValue: value.value,
    'onUpdate:modelValue': (next: V) => { value.value = next },
    options: projects,
    label: '项目',
    ...props,
  }))
  const wrapper = mount(Harness, { attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, value }
}

const input = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
const key = async (target: HTMLElement, name: string) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  await flushPromises()
}
async function type(text: string) {
  input().value = text
  input().dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

describe('OptionCombobox', () => {
  it('single: opens from the keyboard, shows the chosen label and picks with Enter', async () => {
    const { value } = mountCombobox('alpha')
    await flushPromises()
    expect(input().getAttribute('aria-label')).toBe('项目')
    expect(input().value).toBe('Alpha 项目')
    input().focus()
    await key(input(), 'ArrowDown')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(input())
    expect(options().map(option => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
    await key(input(), 'ArrowDown')
    await key(input(), 'Enter')
    expect(value.value).toBe('beta')
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('filters on input by label, value and meta, and shows the empty row', async () => {
    mountCombobox('')
    input().focus()
    await type('gam')
    expect(options().map(option => option.textContent?.trim())).toEqual(['Gamma 项目'])
    await type('#alpha')
    expect(options().map(option => option.textContent?.trim())).toEqual(['Alpha 项目#alpha'])
    await type('nothing here')
    expect(options()).toHaveLength(0)
    expect(document.body.textContent).toContain('没有匹配项')
  })

  it('keeps a disabled option out of reach', async () => {
    const { value } = mountCombobox('')
    input().click()
    await flushPromises()
    expect(options()[3].getAttribute('data-disabled')).toBe('')
    options()[3].click()
    await flushPromises()
    expect(value.value).toBe('')
  })

  it('maps an empty-string option, such as "all", to and from the model', async () => {
    const { value } = mountCombobox('beta', { options: [{ value: '', label: '全部' }, ...projects] })
    input().click()
    await flushPromises()
    options()[0].click()
    await flushPromises()
    expect(value.value).toBe('')
    expect(input().value).toBe('全部')
  })

  it('multiple: adds chips in option order, stays open, and removes with the chip mark or Backspace twice', async () => {
    const { value } = mountCombobox<string[]>([], { multiple: true })
    input().click()
    await flushPromises()
    options()[2].click()
    await flushPromises()
    options()[0].click()
    await flushPromises()
    expect(value.value).toEqual(['alpha', 'gamma'])
    expect(input().getAttribute('aria-expanded')).toBe('true')
    const chips = () => [...document.querySelectorAll<HTMLElement>('[data-select-chip]')]
    expect(chips().map(chip => chip.textContent?.trim())).toEqual(['Alpha 项目', 'Gamma 项目'])

    input().focus()
    await key(input(), 'Backspace')
    expect(value.value).toEqual(['alpha', 'gamma'])
    expect(chips()[1].getAttribute('data-state')).toBe('active')
    await key(input(), 'Backspace')
    expect(value.value).toEqual(['alpha'])

    chips()[0].querySelector<HTMLElement>('button')!.click()
    await flushPromises()
    expect(value.value).toEqual([])
    expect(input().getAttribute('placeholder')).toBe('请选择')
  })

  it('multiple: counts chips past the limit and shows the all label when everything is chosen', async () => {
    const { wrapper, value } = mountCombobox<string[]>(['alpha', 'beta', 'gamma'], { multiple: true, maxChips: 1, allLabel: '全部项目' })
    await flushPromises()
    expect(wrapper.findAll('[data-select-chip]')).toHaveLength(1)
    expect(wrapper.get('[data-select-overflow]').text()).toBe('+2')
    value.value = ['alpha', 'beta', 'gamma', 'delta']
    await flushPromises()
    expect(wrapper.get('[data-select-all-label]').text()).toBe('全部项目')
    expect(wrapper.find('[data-select-chip]').exists()).toBe(false)
  })

  it('multiple: selects all, inverts and clears all, keeping disabled choices', async () => {
    const { value } = mountCombobox<string[]>(['delta'], { multiple: true })
    input().click()
    await flushPromises()
    const action = (name: string) => document.querySelector<HTMLElement>(`[data-select-action="${name}"]`)!
    action('all').click()
    await flushPromises()
    expect(value.value).toEqual(['alpha', 'beta', 'gamma', 'delta'])
    expect(document.querySelector('[data-selection-count]')?.textContent).toBe('已选 4 / 共 4')
    action('clear').click()
    await flushPromises()
    expect(value.value).toEqual(['delta'])
    action('invert').click()
    await flushPromises()
    expect(value.value).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('without search the field takes no typing but still opens and picks from the keyboard', async () => {
    const { value } = mountCombobox<string[]>([], { multiple: true, searchable: false })
    expect(input().readOnly).toBe(true)
    input().focus()
    await key(input(), 'ArrowDown')
    await key(input(), 'Enter')
    expect(value.value).toEqual(['alpha'])
  })

  it('closes on Escape and keeps focus in the field', async () => {
    const { value } = mountCombobox('alpha')
    input().focus()
    await key(input(), 'ArrowDown')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    await key(input(), 'Escape')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(input())
    expect(value.value).toBe('alpha')
  })

  it('takes no input and opens no list while disabled', async () => {
    const { value } = mountCombobox<string[]>(['alpha'], { multiple: true, disabled: true })
    expect(input().disabled).toBe(true)
    input().click()
    await flushPromises()
    expect(options()).toHaveLength(0)
    const remove = document.querySelector<HTMLElement>('[data-select-chip] [data-disabled]')!
    remove.click()
    await flushPromises()
    expect(value.value).toEqual(['alpha'])
  })

  it('shows one loading indicator above the options it has, instead of the empty row', async () => {
    mountCombobox('', { options: [], loading: true })
    input().click()
    await flushPromises()
    const viewport = document.querySelector('[data-slot="combobox-viewport"]')!
    expect(viewport.getAttribute('aria-busy')).toBe('true')
    expect(viewport.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(viewport.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('正在加载选项')
    expect(document.body.textContent).not.toContain('暂无选项')
  })

  it('multiple: a summary replaces the chips', async () => {
    const { wrapper } = mountCombobox<string[]>(['alpha', 'beta'], { multiple: true, summary: '已选 2 / 共 4 个项目' })
    expect(wrapper.get('[data-select-summary]').text()).toBe('已选 2 / 共 4 个项目')
    expect(wrapper.find('[data-select-chip]').exists()).toBe(false)
    expect(input().placeholder).toBe('')
  })

  it('names the field with a visible label and localizes its copy', async () => {
    setLocale('en-US', { persist: false })
    const { wrapper } = mountCombobox('', { field: true, controlId: 'project-picker', options: [] })
    expect(wrapper.get('label').attributes('for')).toBe('project-picker')
    expect(input().id).toBe('project-picker')
    expect(input().getAttribute('aria-label')).toBeNull()
    expect(input().placeholder).toBe('Select an option')
    input().click()
    await flushPromises()
    expect(document.body.textContent).toContain('No options')
  })

  it('opens on the shared spring without delaying focus, and both reduced-motion switches stop it', async () => {
    mountCombobox('')
    input().focus()
    await key(input(), 'ArrowDown')
    const list = document.querySelector('[data-slot="combobox-list"]')!
    expect(list.className).toContain('animate-popover-in')
    expect(document.activeElement).toBe(input())
    expect(tailwindTheme).toMatch(/--animate-popover-in: popover-in var\(--motion-spring\) var\(--motion-ease-spring\)/)
    expect(primitives).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0s !important/)
    expect(primitives).toMatch(/:root\[data-motion="reduced"\] \*[\s\S]*animation-duration: 0s !important/)
  })
})

describe('OptionCombobox before its options arrive', () => {
  it('stays empty instead of showing the raw value, then shows the label', async () => {
    const { wrapper } = mountCombobox('alpha', { options: [] })
    await flushPromises()
    expect(input().value).toBe('')
    wrapper.unmount()
    mounted.pop()
    mountCombobox('alpha')
    await flushPromises()
    expect(input().value).toBe('Alpha 项目')
  })
})

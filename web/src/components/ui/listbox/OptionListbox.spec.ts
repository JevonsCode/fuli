import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { OptionListbox } from '.'

const projects = [
  { value: 'alpha', label: 'Alpha 项目' },
  { value: 'beta', label: 'Beta 项目' },
  { value: 'gamma', label: 'Gamma 项目' },
]
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => { for (const wrapper of mounted.splice(0)) wrapper.unmount() })

function mountListbox(initial: string[], props: Record<string, unknown> = {}) {
  const value = ref(initial)
  const Harness = defineComponent(() => () => h(OptionListbox, {
    modelValue: value.value,
    'onUpdate:modelValue': (next: string[]) => { value.value = next },
    options: projects,
    label: '负责项目',
    ...props,
  }))
  const wrapper = mount(Harness, { attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, value }
}

describe('OptionListbox', () => {
  it('shows every option at once, named by its label, and toggles from the keyboard', async () => {
    const { wrapper, value } = mountListbox(['beta'])
    const list = wrapper.get('[role="listbox"]')
    expect(list.attributes('aria-multiselectable')).toBe('true')
    expect(document.getElementById(list.attributes('aria-labelledby')!)?.textContent).toBe('负责项目')
    expect(wrapper.findAll('[role="option"]').map(option => option.attributes('aria-selected'))).toEqual(['false', 'true', 'false'])
    const search = wrapper.get<HTMLInputElement>('input[type="search"]')
    search.element.focus()
    await flushPromises()
    await search.trigger('keydown', { key: 'ArrowUp' })
    await search.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(value.value).toEqual(['alpha', 'beta'])
    expect(wrapper.get('[data-selection-count]').text()).toBe('已选 2 / 共 3')
  })

  it('filters while keeping choices, says when nothing matches, and leaves Escape to the dialog', async () => {
    const { wrapper, value } = mountListbox(['beta'])
    await wrapper.get('input[type="search"]').setValue('gam')
    expect(wrapper.findAll('[role="option"]').map(option => option.text())).toEqual(['Gamma 项目'])
    await wrapper.get('[role="option"]').trigger('click')
    expect(value.value).toEqual(['beta', 'gamma'])
    await wrapper.get('input[type="search"]').setValue('missing')
    expect(wrapper.text()).toContain('没有匹配项')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    wrapper.get('input[type="search"]').element.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
  })

  it('blocks changes while disabled', async () => {
    const { wrapper, value } = mountListbox([], { disabled: true })
    await wrapper.findAll('[role="option"]')[0].trigger('click')
    expect(value.value).toEqual([])
    expect(wrapper.get('[data-select-action="all"]').attributes('disabled')).toBeDefined()
  })
})

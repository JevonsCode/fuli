import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'

import { setLocale } from '@/i18n'
import { OptionSelect, type SelectOption } from '.'

const priorities: SelectOption[] = [
  { value: '', label: '全部' },
  { value: 'high', label: '高', meta: 'P1' },
  { value: 'low', label: '低', disabled: true },
]

function mountSelect(initial: string, props: Record<string, unknown> = {}) {
  const value = ref(initial)
  const Harness = defineComponent(() => () => h(OptionSelect, {
    modelValue: value.value,
    'onUpdate:modelValue': (next: string) => { value.value = next },
    options: priorities,
    label: '优先级',
    ...props,
  }))
  return { wrapper: mount(Harness, { attachTo: document.body }), value }
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]

describe('OptionSelect', () => {
  it('names the trigger, maps the empty "all" option and picks from the keyboard', async () => {
    const { wrapper, value } = mountSelect('')
    await flushPromises()
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('aria-label')).toBe('优先级')
    expect(trigger.text()).toContain('全部')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(options().map(option => option.textContent?.trim())).toEqual(['全部', '高 P1', '低'])
    expect(options()[2].getAttribute('aria-disabled')).toBe('true')
    options()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(value.value).toBe('high')
    expect(trigger.text()).toContain('高')
    expect(trigger.text()).not.toContain('P1')
    wrapper.unmount()
  })

  it('shows the placeholder for a value no option has, and a visible label as a field', async () => {
    const { wrapper } = mountSelect('missing', { field: true, controlId: 'priority', options: priorities.slice(1), size: 'sm' })
    await flushPromises()
    expect(wrapper.get('label').attributes('for')).toBe('priority')
    const trigger = wrapper.get('#priority')
    expect(trigger.attributes('aria-label')).toBeUndefined()
    expect(trigger.attributes('data-size')).toBe('sm')
    expect(trigger.text()).toContain('请选择')
    wrapper.unmount()
  })

  it('moves to an option by typing its first letters in the open list', async () => {
    const { wrapper, value } = mountSelect('', { options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    await flushPromises()
    expect(document.activeElement?.textContent?.trim()).toBe('Beta')
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(value.value).toBe('beta')
    wrapper.unmount()
  })

  it('stays closed while disabled', async () => {
    const { wrapper } = mountSelect('high', { disabled: true })
    await flushPromises()
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('disabled')).toBeDefined()
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(options()).toHaveLength(0)
    wrapper.unmount()
  })

  it('says when there are no options, and shows one loading indicator while they arrive', async () => {
    const { wrapper } = mountSelect('', { options: [] })
    await flushPromises()
    await wrapper.get('[role="combobox"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(document.querySelector('[data-select-empty]')?.textContent).toBe('暂无选项')
    wrapper.unmount()

    const loading = mountSelect('', { options: [], loading: true })
    await flushPromises()
    const trigger = loading.wrapper.get('[role="combobox"]')
    expect(trigger.attributes('aria-busy')).toBe('true')
    await trigger.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(document.querySelectorAll('[data-slot="select-content"] [role="status"]')).toHaveLength(1)
    expect(document.querySelector('[data-slot="select-content"] [role="status"]')?.getAttribute('aria-label')).toBe('正在加载选项')
    expect(document.querySelector('[data-select-empty]')).toBeNull()
    loading.wrapper.unmount()
  })

  it('localizes the default placeholder', async () => {
    setLocale('en-US', { persist: false })
    const { wrapper } = mountSelect('', { options: priorities.slice(1) })
    await flushPromises()
    expect(wrapper.get('[role="combobox"]').text()).toContain('Select an option')
    wrapper.unmount()
  })
})

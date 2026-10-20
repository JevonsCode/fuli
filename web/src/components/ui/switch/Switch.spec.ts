import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { Switch } from '.'

describe('Switch', () => {
  it('renders a button with switch semantics and an accessible name', () => {
    const control = mount(Switch, { props: { modelValue: false }, attrs: { 'aria-label': '自动捕获' } }).get('[role="switch"]')
    expect(control.element.tagName).toBe('BUTTON')
    expect(control.attributes()).toMatchObject({ 'type': 'button', 'data-slot': 'switch', 'aria-checked': 'false', 'aria-label': '自动捕获', 'data-state': 'unchecked' })
  })

  it('toggles v-model on click and on Enter', async () => {
    const wrapper = mount(Switch, { props: { 'modelValue': false, 'onUpdate:modelValue': (value: boolean) => wrapper.setProps({ modelValue: value }) } })
    const control = wrapper.get('[role="switch"]')
    await control.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
    expect(control.attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-slot="switch-thumb"]').attributes('data-state')).toBe('checked')
    await control.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[1]).toEqual([false])
    expect(control.attributes('aria-checked')).toBe('false')
  })

  it('does not toggle while disabled', async () => {
    const wrapper = mount(Switch, { props: { modelValue: true, disabled: true } })
    const control = wrapper.get('[role="switch"]')
    expect(control.attributes('disabled')).toBeDefined()
    await control.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})

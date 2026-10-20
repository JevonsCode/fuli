import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { Checkbox } from '.'

describe('Checkbox', () => {
  it('renders a button with checkbox semantics and shows the check only when checked', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false }, attrs: { 'aria-label': '包含已归档' } })
    const box = wrapper.get('[role="checkbox"]')
    expect(box.element.tagName).toBe('BUTTON')
    expect(box.attributes()).toMatchObject({ 'data-slot': 'checkbox', 'aria-checked': 'false', 'aria-label': '包含已归档' })
    expect(wrapper.find('[data-slot="checkbox-indicator"]').exists()).toBe(false)
    await wrapper.setProps({ modelValue: true })
    expect(box.attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-slot="checkbox-indicator"] svg').attributes('aria-hidden')).toBe('true')
  })

  it('reports an indeterminate state as mixed', () => {
    expect(mount(Checkbox, { props: { modelValue: 'indeterminate' } }).get('[role="checkbox"]').attributes('aria-checked')).toBe('mixed')
  })

  it('toggles v-model on click but not on Enter, as WAI-ARIA checkboxes do', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false } })
    const box = wrapper.get('[role="checkbox"]')
    await box.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await box.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('does not toggle while disabled', async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, disabled: true } })
    const box = wrapper.get('[role="checkbox"]')
    expect(box.attributes('disabled')).toBeDefined()
    await box.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})

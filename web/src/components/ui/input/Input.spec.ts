import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { Input } from '.'

describe('Input', () => {
  it('renders a native input that passes its attributes through', () => {
    const input = mount(Input, { attrs: { 'id': 'name', 'type': 'email', 'placeholder': '邮箱', 'aria-invalid': 'true' } }).get('input')
    expect(input.attributes()).toMatchObject({ 'data-slot': 'input', 'id': 'name', 'type': 'email', 'placeholder': '邮箱', 'aria-invalid': 'true' })
  })

  it('binds v-model both ways and starts from defaultValue when uncontrolled', async () => {
    const wrapper = mount(Input, { props: { modelValue: 'a' } })
    const input = wrapper.get('input')
    expect(input.element.value).toBe('a')
    await input.setValue('ab')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['ab'])
    await wrapper.setProps({ modelValue: 'reset' })
    expect(input.element.value).toBe('reset')
    expect(mount(Input, { props: { defaultValue: 'draft' } }).get('input').element.value).toBe('draft')
  })

  it('stays disabled and lets a caller class win', () => {
    const input = mount(Input, { props: { class: 'h-8' }, attrs: { disabled: true } }).get('input')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.classes()).toContain('h-8')
    expect(input.classes()).not.toContain('h-(--control-height)')
  })
})

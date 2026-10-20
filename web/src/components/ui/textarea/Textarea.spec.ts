import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { Textarea } from '.'

describe('Textarea', () => {
  it('renders a native textarea that passes its attributes through', () => {
    const textarea = mount(Textarea, { attrs: { 'id': 'note', 'rows': '4', 'aria-describedby': 'note-help' } }).get('textarea')
    expect(textarea.attributes()).toMatchObject({ 'data-slot': 'textarea', 'id': 'note', 'rows': '4', 'aria-describedby': 'note-help' })
  })

  it('binds v-model both ways and starts from defaultValue when uncontrolled', async () => {
    const wrapper = mount(Textarea, { props: { modelValue: '第一行' } })
    const textarea = wrapper.get('textarea')
    expect(textarea.element.value).toBe('第一行')
    await textarea.setValue('第一行\n第二行')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['第一行\n第二行'])
    expect(mount(Textarea, { props: { defaultValue: 'draft' } }).get('textarea').element.value).toBe('draft')
  })

  it('stays disabled', () => {
    expect(mount(Textarea, { attrs: { disabled: true } }).get('textarea').attributes('disabled')).toBeDefined()
  })
})

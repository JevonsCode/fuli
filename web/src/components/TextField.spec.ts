import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import TextField from './TextField.vue'

describe('TextField', () => {
  it('keeps the label wrapper while forwarding attributes to the control', async () => {
    const wrapper = mount(TextField, {
      props: {
        modelValue: 'before',
        label: '名称',
      },
      attrs: {
        'data-testid': 'name-field',
        placeholder: '请输入名称',
      },
    })

    const input = wrapper.get('[data-testid="name-field"]')
    expect(input.element.tagName).toBe('INPUT')
    expect(input.attributes('placeholder')).toBe('请输入名称')

    await input.setValue('after')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['after'])
  })

  it('renders a multiline control when requested', () => {
    const wrapper = mount(TextField, {
      props: {
        modelValue: '{}',
        label: '来源 JSON',
        multiline: true,
      },
    })

    expect(wrapper.get('textarea').attributes('rows')).toBe('3')
  })
})

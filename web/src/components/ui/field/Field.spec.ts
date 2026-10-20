import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { Input } from '../input'
import { Field, FieldDescription, FieldError, FieldLabel } from '.'

describe('Field', () => {
  it('groups a label, control, help text and error that the page wires by id', () => {
    const wrapper = mount({
      render: () => h(Field, { 'data-invalid': 'true' }, () => [
        h(FieldLabel, { for: 'endpoint' }, () => '地址'),
        h(Input, { 'id': 'endpoint', 'aria-invalid': 'true', 'aria-describedby': 'endpoint-help endpoint-error' }),
        h(FieldDescription, { id: 'endpoint-help' }, () => '本机地址'),
        h(FieldError, { id: 'endpoint-error', errors: ['必须以 http 开头'] }),
      ]),
    }, { attachTo: document.body })
    const field = wrapper.get('[data-slot="field"]')
    expect(field.attributes()).toMatchObject({ 'role': 'group', 'data-invalid': 'true' })
    expect(wrapper.get('label').attributes()).toMatchObject({ 'data-slot': 'field-label', 'for': 'endpoint' })
    expect(wrapper.get('[data-slot="field-description"]').text()).toBe('本机地址')
    const error = wrapper.get('[role="alert"]')
    expect(error.attributes('id')).toBe('endpoint-error')
    expect(error.text()).toBe('必须以 http 开头')
    const input = document.getElementById('endpoint') as HTMLInputElement
    expect(input.labels?.[0]?.textContent).toBe('地址')
    wrapper.unmount()
  })

  it('lays out side by side when horizontal', () => {
    const field = mount(Field, { props: { orientation: 'horizontal' } }).get('[data-slot="field"]')
    expect(field.attributes('data-orientation')).toBe('horizontal')
    expect(field.classes()).toContain('flex-row')
  })

  it('shows no error box without errors, one line for one error and a list for several', () => {
    expect(mount(FieldError, { props: { errors: [] } }).find('[role="alert"]').exists()).toBe(false)
    expect(mount(FieldError, { props: { errors: [undefined, { message: '必填' }, '必填'] } }).get('[role="alert"]').text()).toBe('必填')
    const several = mount(FieldError, { props: { errors: ['太短', { message: '含空格' }] } })
    expect(several.findAll('li').map(item => item.text())).toEqual(['太短', '含空格'])
    expect(mount(FieldError, { slots: { default: '自定义' } }).get('[role="alert"]').text()).toBe('自定义')
  })
})

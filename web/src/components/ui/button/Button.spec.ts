import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { Button } from '.'

describe('Button', () => {
  it('names its variant and size, defaults included, and never submits by accident', () => {
    const primary = mount(Button, { slots: { default: 'Save' } }).get('button')
    expect(primary.attributes('data-slot')).toBe('button')
    expect(primary.attributes('data-variant')).toBe('default')
    expect(primary.attributes('data-size')).toBe('default')
    expect(primary.attributes('type')).toBe('button')
    const submit = mount(Button, { props: { type: 'submit', variant: 'destructive', size: 'sm' } }).get('button')
    expect(submit.attributes()).toMatchObject({ 'type': 'submit', 'data-variant': 'destructive', 'data-size': 'sm' })
  })

  it('shows the inline loading label and refuses a second click while pending', async () => {
    const wrapper = mount(Button, { props: { loading: true, loadingLabel: '正在保存…' }, slots: { default: '保存' } })
    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('aria-busy')).toBe('true')
    expect(button.find('.growth-loading--inline').exists()).toBe(true)
    expect(button.get('.growth-loading__label').text()).toBe('正在保存…')
    expect(button.text()).not.toContain('保存 ')
    await wrapper.setProps({ loading: false })
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('aria-busy')).toBeUndefined()
    expect(button.text()).toBe('保存')
  })

  it('keeps an explicit disabled state', () => {
    expect(mount(Button, { props: { disabled: true } }).get('button').attributes('disabled')).toBeDefined()
  })

  it('styles a link as a button without button-only attributes', () => {
    const wrapper = mount(Button, {
      props: { asChild: true, variant: 'outline' },
      slots: { default: () => h(RouterLinkStub, { to: '/inbox' }, () => 'Inbox') },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
    const link = wrapper.getComponent(RouterLinkStub)
    expect(link.props('to')).toBe('/inbox')
    expect(link.attributes('data-variant')).toBe('outline')
    expect(link.attributes('type')).toBeUndefined()
    expect(link.attributes('disabled')).toBeUndefined()
  })

  it('lets a caller class win over a conflicting variant utility', () => {
    const button = mount(Button, { props: { class: 'rounded-full extra' } }).get('button')
    expect(button.classes()).toContain('rounded-full')
    expect(button.classes()).toContain('extra')
    expect(button.classes()).not.toContain('rounded-md')
  })
})

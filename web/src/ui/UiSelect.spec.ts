import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import UiSelect from './UiSelect.vue'

const projects = [
  { value: 'project-a', label: '项目 Alpha', meta: '#project-a' },
  { value: 'project-b-2026', label: '同名项目', meta: '#project-b' },
  { value: 'project-c', label: '项目 Gamma' },
  { value: 'project-d', label: '项目 Delta', disabled: true },
]

describe('UiSelect', () => {
  beforeEach(() => setLocale('zh-CN', { persist: false }))

  it('single: searches labels and IDs, emits once and closes', async () => {
    const wrapper = mount(UiSelect, { attachTo: document.body,
      props: { modelValue: 'project-a', label: '个人项目', searchable: true, options: projects } })
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.text()).toContain('项目 Alpha')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    await wrapper.get('input[type="search"]').setValue('project-b-2026')
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(1)
    await options[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['project-b-2026']])
    expect(wrapper.emitted('change')).toEqual([['project-b-2026']])
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('a second trigger click closes the panel', async () => {
    const wrapper = mount(UiSelect, { attachTo: document.body,
      props: { modelValue: 'project-a', label: '个人项目', options: projects } })
    const trigger = wrapper.get('[role="combobox"]')
    await trigger.trigger('click')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('multiple: toggles values, stays open, summarizes, inverts and clears', async () => {
    const wrapper = mount(UiSelect, { attachTo: document.body,
      props: { modelValue: [] as string[], multiple: true, label: '项目', options: projects,
        'onUpdate:modelValue': (value: string | string[]) => wrapper.setProps({ modelValue: value as string[] }) } })
    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.text()).toContain('请选择')
    await trigger.trigger('click')
    expect(wrapper.get('[role="listbox"]').attributes('aria-multiselectable')).toBe('true')
    await wrapper.findAll('[role="option"]')[0].trigger('click')
    await wrapper.findAll('[role="option"]')[2].trigger('click')
    expect(wrapper.props('modelValue')).toEqual(['project-a', 'project-c'])
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(trigger.text()).toContain('已选 2 项')
    await wrapper.findAll('.ui-select__actions button')[0].trigger('click')
    expect(wrapper.props('modelValue')).toEqual(['project-b-2026'])
    await wrapper.findAll('.ui-select__actions button')[1].trigger('click')
    expect(wrapper.props('modelValue')).toEqual([])
    wrapper.unmount()
  })

  it('disabled options cannot be chosen', async () => {
    const wrapper = mount(UiSelect, { attachTo: document.body,
      props: { modelValue: '', label: '项目', options: projects } })
    await wrapper.get('[role="combobox"]').trigger('click')
    await wrapper.findAll('[role="option"]')[3].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('localizes its search affordance and empty state', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(UiSelect, { attachTo: document.body,
      props: { modelValue: '', label: 'Personal project', searchable: true, options: [{ value: 'a', label: 'Project Alpha' }] } })
    await wrapper.get('[role="combobox"]').trigger('click')
    const search = wrapper.get('input[type="search"]')
    expect(search.attributes('placeholder')).toBe('Search')
    expect(search.attributes('aria-label')).toBe('Search Personal project')
    await search.setValue('missing')
    expect(wrapper.text()).toContain('No matching options')
    wrapper.unmount()
  })
})

import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import SearchableSelect from './SearchableSelect.vue'

describe('SearchableSelect', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('searches labels and IDs, then emits the selected value', async () => {
    const wrapper = mount(SearchableSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'project-a',
        label: '个人项目',
        searchable: true,
        options: [
          { value: 'project-a', label: '项目 Alpha', meta: '#project-a' },
          { value: 'project-b-2026', label: '同名项目', meta: '#project-b' },
        ],
      },
    })

    const trigger = wrapper.get('[role="combobox"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.text()).toContain('项目 Alpha')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await wrapper.get('input[type="search"]').setValue('project-b-2026')
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(1)
    expect(options[0].text()).toContain('同名项目')

    await options[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['project-b-2026']])
    expect(wrapper.emitted('change')).toEqual([['project-b-2026']])
    wrapper.unmount()
  })

  it('closes when the trigger is clicked a second time', async () => {
    const wrapper = mount(SearchableSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'project-a',
        label: '个人项目',
        options: [
          { value: 'project-a', label: '项目 Alpha' },
          { value: 'project-b', label: '项目 Beta' },
        ],
      },
    })

    const trigger = wrapper.get('[role="combobox"]')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('keeps the panel open when focus moves between controls inside the component', async () => {
    const wrapper = mount(SearchableSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'project-a',
        label: '个人项目',
        options: [
          { value: 'project-a', label: '项目 Alpha' },
          { value: 'project-b', label: '项目 Beta' },
        ],
      },
    })

    const trigger = wrapper.get('[role="combobox"]')
    await trigger.trigger('click')
    const option = wrapper.get('[role="option"]')
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    option.element.dispatchEvent(new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: trigger.element,
    }))
    await nextTick()

    expect(trigger.attributes('aria-expanded')).toBe('true')
    outside.remove()
    wrapper.unmount()
  })

  it('keeps a pointer choice available while the search input owns focus', async () => {
    const wrapper = mount(SearchableSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'project-a',
        label: '个人项目',
        searchable: true,
        options: [
          { value: 'project-a', label: '项目 Alpha' },
          { value: 'project-b', label: '项目 Beta' },
        ],
      },
    })

    await wrapper.get('[role="combobox"]').trigger('click')
    const search = wrapper.get('input[type="search"]')
    const option = wrapper.findAll('[role="option"]')[1]
    expect(document.activeElement).toBe(search.element)

    const pointerStart = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
    })
    expect(option.element.dispatchEvent(pointerStart)).toBe(false)
    expect(document.activeElement).toBe(search.element)

    await option.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([['project-b']])
    wrapper.unmount()
  })

  it('localizes its built-in empty state and search affordance', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(SearchableSelect, {
      props: {
        modelValue: '',
        label: 'Personal project',
        searchable: true,
        options: [{ value: 'project-a', label: 'Project Alpha' }],
      },
    })

    await wrapper.get('[role="combobox"]').trigger('click')
    const search = wrapper.get('input[type="search"]')
    expect(search.attributes('placeholder')).toBe('Search name or ID')
    expect(search.attributes('aria-label')).toBe('Search Personal project')

    await search.setValue('missing')
    expect(wrapper.text()).toContain('No matching options')
  })
})

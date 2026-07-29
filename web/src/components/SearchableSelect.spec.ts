import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SearchableSelect from './SearchableSelect.vue'

describe('SearchableSelect', () => {
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
})

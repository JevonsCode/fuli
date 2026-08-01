import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import SearchableMultiSelect from './SearchableMultiSelect.vue'

const options = [
  { value: 'project-a', label: 'Project A' },
  { value: 'project-b', label: 'Project B' },
]

describe('SearchableMultiSelect', () => {
  it('opens and closes when the trigger is clicked twice', async () => {
    const wrapper = mount(SearchableMultiSelect, {
      props: { modelValue: [], options, label: '绑定项目' },
    })
    const trigger = wrapper.get('.searchable-select-trigger')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('toggles multiple custom options without falling back to a native select', async () => {
    const wrapper = mount(SearchableMultiSelect, {
      props: { modelValue: ['project-a'], options, label: '绑定项目', required: true },
    })
    await wrapper.get('.searchable-select-trigger').trigger('click')
    await wrapper.findAll('[role="option"]')[1].trigger('click')

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([
      ['project-a', 'project-b'],
    ])
    expect(wrapper.get('.searchable-select-trigger').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.get('[role="listbox"]').attributes('aria-multiselectable')).toBe('true')
  })
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import GrowthLoading from './GrowthLoading.vue'

describe('GrowthLoading', () => {
  it('keeps the loading copy as the accessible status and hides the decorative chart', () => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取知识…' },
    })

    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
    expect(wrapper.get('.growth-loading__label').text()).toBe('正在读取知识…')
    expect(wrapper.get('.growth-loading__chart').attributes('aria-hidden')).toBe('true')
    expect(wrapper.findAll('.growth-loading__bar')).toHaveLength(5)
  })
})

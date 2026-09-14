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

  it.each(['page', 'compact', 'inline'] as const)('uses the same animation and live status in the %s variant', async (variant) => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取 Agent 名录…', variant },
    })
    expect(wrapper.classes()).toContain(`growth-loading--${variant}`)
    expect(wrapper.classes('view-loading')).toBe(variant === 'page')
    expect(wrapper.findAll('.growth-loading__bar')).toHaveLength(5)
    expect(wrapper.attributes('role')).toBe('status')
    await wrapper.setProps({ label: '正在读取任务看板…' })
    expect(wrapper.text()).toBe('正在读取任务看板…')
    expect(wrapper.findAll('div, button, a')).toHaveLength(0)
  })
})

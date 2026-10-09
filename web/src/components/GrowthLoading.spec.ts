import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import GrowthLoading from './GrowthLoading.vue'

describe('GrowthLoading', () => {
  it('keeps one accessible status around the label and hides the decorative mark', () => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取知识…' },
    })

    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
    expect(wrapper.attributes('aria-label')).toBe('正在读取知识…')
    expect(wrapper.get('.growth-loading__label').text()).toBe('正在读取知识…')
    expect(wrapper.get('.growth-loading__mark').attributes('aria-hidden')).toBe('true')
    expect(wrapper.findAll('.growth-loading__arc')).toHaveLength(3)
    expect(wrapper.findAll('.growth-loading__bar')).toHaveLength(0)
  })

  it.each(['page', 'compact', 'inline'] as const)('uses the same animation and live status in the %s variant', async (variant) => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取 Agent 名录…', variant },
    })
    expect(wrapper.classes()).toContain(`growth-loading--${variant}`)
    expect(wrapper.classes('view-loading')).toBe(variant === 'page')
    expect(wrapper.find('.growth-loading__mark').exists()).toBe(true)
    expect(wrapper.findAll('.growth-loading__arc')).toHaveLength(3)
    expect(wrapper.attributes('role')).toBe('status')
    await wrapper.setProps({ label: '正在读取任务看板…' })
    expect(wrapper.text()).toBe('正在读取任务看板…')
    expect(wrapper.findAll('div, button, a')).toHaveLength(0)
  })
})

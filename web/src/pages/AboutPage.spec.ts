import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import AboutPage from './AboutPage.vue'

describe('AboutPage', () => {
  afterEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('presents the product principles, label system, and open-source credits', () => {
    const wrapper = mount(AboutPage)

    expect(wrapper.findAll('.principle-sequence article')).toHaveLength(4)
    expect(wrapper.text()).toContain('Agent 可以建议归属，但项目由用户指定')
    expect(wrapper.text()).toContain('跨 Agent 复用自己的方法')
    expect(wrapper.findAll('.label-dimension-strip article')).toHaveLength(3)
    expect(wrapper.findAll('.profile-guide .label-definition-row')).toHaveLength(3)
    expect(wrapper.findAll('.quadrant-grid article')).toHaveLength(4)
    expect(wrapper.findAll('.confirmation-guide .status-definition-row')).toHaveLength(3)
    expect(wrapper.text()).toContain('至少 5 次有效使用、覆盖 3 个任务')
    expect(wrapper.text()).toContain('“全部”只是当前筛选条件')
    expect(wrapper.findAll('.credit-grid a')).toHaveLength(11)
    const creditLogos = wrapper.findAll('.credit-mark img')
    expect(creditLogos).toHaveLength(11)
    expect(creditLogos.every((logo) => (logo.attributes('src') ?? '').startsWith('https://'))).toBe(true)
    expect(creditLogos.some((logo) => (logo.attributes('src') ?? '').includes('/assets/credits/'))).toBe(false)
    expect(wrapper.get('.fuli-finale img').attributes('src')).toBeTruthy()
  })

  it('supports the English about page', () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(AboutPage)

    expect(wrapper.text()).toContain('Conversations end. Methods should remain.')
    expect(wrapper.text()).toContain('Preference type')
    expect(wrapper.text()).toContain('Blind-spot exploration')
    expect(wrapper.text()).toContain('At least 5 qualified uses across 3 tasks')
    expect(wrapper.text()).toContain('Open-source credits')
  })
})

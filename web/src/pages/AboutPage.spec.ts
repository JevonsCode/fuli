import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import AboutPage from './AboutPage.vue'

describe('AboutPage', () => {
  afterEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('presents the principles, label system, and open-source credits', async () => {
    const wrapper = mount(AboutPage)

    expect(wrapper.get('.about-opening-claim').text()).toBe('换 AI 工具，留住你自己')
    // One 理念 section: one heading, then each principle as a headline and one sentence.
    const principles = wrapper.get('.product-principles')
    expect(principles.findAll('h2').map(h => h.text())).toEqual(['我们的理念'])
    expect(principles.findAll('.principle-list li').map(li => li.attributes('data-principle')))
      .toEqual(['partners', 'retain', 'onDemand', 'authority', 'history', 'local'])
    expect(principles.findAll('.principle-list li > span').map(s => s.text())).toEqual(['01', '02', '03', '04', '05', '06'])
    expect(principles.findAll('.principle-list h3')[5].text()).toBe('就在你的电脑上')
    expect(principles.text()).toContain('不用注册，也不用登录')
    expect(principles.text()).toContain('省下上下文和 token')
    expect(wrapper.findAll('.label-dimension-strip article')).toHaveLength(3)
    expect(wrapper.findAll('.profile-guide .label-definition-row')).toHaveLength(3)
    expect(wrapper.findAll('.quadrant-grid article')).toHaveLength(4)
    expect(wrapper.findAll('.confirmation-guide .status-definition-row')).toHaveLength(3)
    expect(wrapper.text()).toContain('至少 5 次有效使用、覆盖 3 个任务')
    expect(wrapper.text()).toContain('“全部”只是筛选条件')
    expect(wrapper.findAll('details')).toHaveLength(0)
    expect(wrapper.findAll('.credit-grid a').map(a => a.attributes('data-credit'))).toEqual([
      'Vue.js', 'Vite', 'Pinia', 'D3.js', 'Vitest', 'Neo4j', 'Zod', 'Tailwind CSS',
      'Reka UI', 'shadcn-vue', 'VueUse', 'Inter', 'Noto Sans SC', 'FastAPI', 'Graphiti', 'MCP',
    ])
    expect(wrapper.findAll('.credit-grid img')).toHaveLength(16)
    const vue = wrapper.get('[data-credit="Vue.js"]')
    expect(vue.get('small').text()).toBe('界面框架')
    // A logo that fails to load becomes a quiet initial tile, never a broken image.
    await vue.get('img').trigger('error')
    expect(vue.find('img').exists()).toBe(false)
    expect(vue.get('.credit-mark.is-fallback').text()).toBe('V')
    expect(wrapper.get('[data-testid="about-opening-logo"]').attributes('src')).toBeTruthy()
    expect(wrapper.get('.fuli-finale img').attributes('src')).toBeTruthy()
    expect(wrapper.get('[data-testid="about-website-link"]').attributes('href')).toBe('https://xn--8ovp9s.xn--m8txu.com/fuli/')
  })

  it('supports the English about page', () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(AboutPage)

    expect(wrapper.text()).toContain('Switch AI tools. Keep yourself.')
    expect(wrapper.text()).toContain('Preference type')
    expect(wrapper.text()).toContain('Blind-spot exploration')
    expect(wrapper.text()).toContain('At least 5 qualified uses across 3 tasks')
    expect(wrapper.text()).toContain('What we believe')
    expect(wrapper.text()).toContain('On your own computer')
    expect(wrapper.get('[data-credit="Reka UI"] small').text()).toBe('Accessible interface primitives')
    expect(wrapper.text()).toContain('Open-source credits')
    expect(wrapper.get('[data-testid="about-website-link"]').text()).toContain('Visit the FULI website')
  })
})

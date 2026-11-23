import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setLocale } from '@/i18n'
import JefaReadStatus from './JefaReadStatus.vue'

const props = { loading: true, longWait: false, stage: 'board' as const, timedOut: false, failure: '', failures: [], total: 25, loaded: 16, pending: 9,
  hasContent: true, stale: false, updatedAt: '', blocking: false, canClearFilter: false, projects: [] }
const render = (patch = {}) => mount(JefaReadStatus, { props: { ...props, ...patch },
  global: { plugins: [createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })] } })

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('the Jefa read status', () => {
  it('floats a read in progress, so the board under it never moves', () => {
    const wrapper = render()
    expect(wrapper.find('[data-jefa-read-chip]').exists()).toBe(true)
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
    expect(wrapper.get('.jefa-read-chip-count').text()).toBe('16/25')
  })

  it('stays the whole page while no board is under it', () => {
    const wrapper = render({ blocking: true })
    expect(wrapper.find('[data-jefa-read-chip]').exists()).toBe(false)
    expect(wrapper.find('.jefa-read-status').exists()).toBe(true)
  })

  it('names why a project could not be read in words, never an error class or HTTP code', () => {
    const at = '2026-10-21T00:00:00Z'
    const failures = [
      { projectId: 'p1', stage: 'board' as const, category: 'HTTP 403', at },
      { projectId: 'p2', stage: 'board' as const, category: 'TimeoutError', at },
      { projectId: 'p3', stage: 'board' as const, category: 'TypeError', at },
      { projectId: 'p4', stage: 'board' as const, category: 'HTTP 503', at },
    ]
    const text = render({ loading: false, blocking: true, failures, projects: [] }).get('.jefa-read-details').text()
    expect(text).toContain('没有权限')
    expect(text).toContain('读取超时')
    expect(text).toContain('读取失败')
    expect(text).toContain('服务暂时不可用')
    expect(text).not.toMatch(/HTTP|TypeError|TimeoutError/)
  })
})

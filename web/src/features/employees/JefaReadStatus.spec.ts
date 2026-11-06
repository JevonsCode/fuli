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
})

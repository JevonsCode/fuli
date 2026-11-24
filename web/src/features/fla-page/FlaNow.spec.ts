import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import FlaNow from './FlaNow.vue'
import { nowLine } from './fla-now'

// Synthetic task only. A task started three days ago; what 现在 says depends on its last recorded change.
const NOW = Date.parse('2026-11-24T09:05:00Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const entry = (lastUpdateAt: string | null): AgentWorkbenchEntry => ({ status: 'running', source: 'roster', taskId: 't-1', title: 'Synthetic task',
  lastUpdateAt, reason: null, runningSince: minutesBefore(3 * 24 * 60) })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

function render(lastUpdateAt: string | null) {
  const value = entry(lastUpdateAt)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  return mount(FlaNow, { global: { plugins: [router] }, props: { entry: value,
    line: nowLine({ entry: value, agentId: 'fla-1', sheets: [], tasks: [], now: NOW }) } })
}

describe('现在 · a running task', () => {
  it('reads as going on, with a live dot, when it changed 5 minutes ago', () => {
    const wrapper = render(minutesBefore(5))
    expect(wrapper.get('.now-state').text()).toBe('正在做')
    expect(wrapper.get('.now-dot').classes()).toContain('is-live')
    expect(wrapper.get('[data-now-since]').text()).toBe('已经做了 3天')
  })

  it.each([[120, '2小时'], [3 * 24 * 60, '3天']])('says when it last moved, still, after %i minutes without a change', (minutes, duration) => {
    const wrapper = render(minutesBefore(minutes))
    expect(wrapper.get('.now-state').text()).toBe(`上次有进展是 ${duration}前`)
    expect(wrapper.text()).not.toContain('正在做')
    expect(wrapper.get('.now-dot').classes()).not.toContain('is-live')
    expect(wrapper.find('[data-now-since]').exists()).toBe(false)
  })

  it('says no progress was recorded, still, when there is no time', () => {
    const wrapper = render(null)
    expect(wrapper.get('[data-now-since]').text()).toBe('没有记下最近进展')
    expect(wrapper.get('.now-dot').classes()).not.toContain('is-live')
  })
})

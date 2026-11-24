import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import { setLocale } from '@/i18n'
import FlaNow from './FlaNow.vue'
import { nowLine } from './fla-now'

// Synthetic task only. A task started three days ago; what 现在 says depends on its last recorded change.
const NOW = Date.parse('2026-11-24T09:05:00Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const entry = (lastUpdateAt: string | null): AgentWorkbenchEntry => ({ status: 'running', source: 'roster', taskId: 't-1', title: 'Synthetic task',
  lastUpdateAt, reason: null, runningSince: minutesBefore(3 * 24 * 60) })

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers(); setLocale('zh-CN') })

function render(lastUpdateAt: string | null) {
  const value = entry(lastUpdateAt)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  return mount(FlaNow, { global: { plugins: [router] }, props: { entry: value,
    line: nowLine({ entry: value, agentId: 'fla-1', sheets: [], tasks: [], now: NOW }) } })
}

describe('现在 · a running task says its last change, never that it stopped', () => {
  it('5 minutes ago: 正在做, when it changed, and a live dot; how long it ran is on hover', () => {
    const wrapper = render(minutesBefore(5))
    expect(wrapper.get('.now-state').text()).toBe('正在做')
    expect(wrapper.get('[data-now-progress]').text()).toBe('最近进展 5分钟前')
    expect(wrapper.get('[data-now-progress]').attributes('title')).toBe('已经做了 3天')
    expect(wrapper.text()).not.toContain('已经做了')
    expect(wrapper.get('.now-dot').classes()).toContain('is-live')
    expect(wrapper.get('.now-dot').attributes('data-tone')).toBe('active')
  })

  it('under a minute ago reads 刚刚有进展', () => {
    expect(render(new Date(NOW - 20_000).toISOString()).get('[data-now-progress]').text()).toBe('刚刚有进展')
  })

  it.each([[120, '2小时前'], [3 * 24 * 60, '3天前']])('%i minutes without a change: still 正在做, the fact, a still neutral dot', (minutes, ago) => {
    const wrapper = render(minutesBefore(minutes))
    expect(wrapper.get('.now-state').text()).toBe('正在做')
    expect(wrapper.get('[data-now-progress]').text()).toBe(`最近进展 ${ago}`)
    expect(wrapper.text()).not.toMatch(/停在|上次有进展是/)
    expect(wrapper.get('.now-dot').classes()).not.toContain('is-live')
    expect(wrapper.get('.now-dot').attributes('data-tone')).toBe('quiet')
  })

  it('no recorded change: still 正在做, says none was recorded, a still neutral dot', () => {
    const wrapper = render(null)
    expect(wrapper.get('.now-state').text()).toBe('正在做')
    expect(wrapper.get('[data-now-progress]').text()).toBe('没有记下最近进展')
    expect(wrapper.get('.now-dot').classes()).not.toContain('is-live')
    expect(wrapper.get('.now-dot').attributes('data-tone')).toBe('quiet')
  })

  it('says the same facts in English', () => {
    setLocale('en-US')
    expect(render(minutesBefore(3 * 24 * 60)).get('[data-now-progress]').text()).toBe('Last progress 3 days ago')
    expect(render(null).get('[data-now-progress]').text()).toBe('No recent progress recorded')
  })
})

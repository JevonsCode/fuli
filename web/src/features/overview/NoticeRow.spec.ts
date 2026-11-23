import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import NoticeRow from './NoticeRow.vue'

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
const notice = (kind: string) => ({ id: `synthetic-${kind}`, kind, at: '2026-11-18T09:00:00.000Z',
  params: { name: 'Synthetic Mac', device: 'mac', fingerprint: 'ab12', role: 'chat' }, href: '/settings' })

describe('NoticeRow', () => {
  // 11-18: an entry still in testing says so with the shared Beta badge, beside the time.
  it('marks a runner pairing as Beta and leaves stable notices plain', async () => {
    const runner = mount(NoticeRow, { props: { item: notice('runner_paired') }, global: { plugins: [router] } })
    const badge = runner.get('.notice-meta [data-beta-badge]')
    expect(badge.text()).toBe('Beta')
    expect(badge.attributes('title')).toBeTruthy()
    const stable = mount(NoticeRow, { props: { item: notice('fla_joined') }, global: { plugins: [router] } })
    expect(stable.find('[data-beta-badge]').exists()).toBe(false)
  })
})

describe('a runner pairing the person does not recognise', () => {
  it('is revoked from the notice itself after one confirming click, never by a terminal command', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init]); return Response.json({ ok: true }) }))
    try {
      const row = mount(NoticeRow, { props: { item: notice('runner_paired') }, global: { plugins: [router] } })
      expect(row.text()).not.toMatch(/fuli runner/)
      await row.get('[data-runner-revoke]').trigger('click')
      expect(calls).toHaveLength(0)
      expect(row.get('[data-runner-revoke]').text()).toBe('确认撤销')
      await row.get('[data-runner-revoke]').trigger('click')
      await flushPromises()
      expect(calls.map(([url, init]) => [url, init?.method])).toEqual([['/api/runners/ab12', 'DELETE']])
      expect(row.get('[data-runner-revoked]').text()).toContain('已撤销')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('can be left alone: 取消 puts the row back', async () => {
    const row = mount(NoticeRow, { props: { item: notice('runner_paired') }, global: { plugins: [router] } })
    await row.get('[data-runner-revoke]').trigger('click')
    await row.get('[data-runner-revoke-cancel]').trigger('click')
    expect(row.get('[data-runner-revoke]').text()).toBe('撤销')
  })
})

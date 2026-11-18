import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
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

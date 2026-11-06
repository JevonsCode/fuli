import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import RecentNotices from './RecentNotices.vue'

const notice = (kind: string, id: string, params: Record<string, string | number>, href = '/inbox') =>
  ({ id: `${kind}:${id}`, kind, at: new Date().toISOString(), params, href })

async function mountNotices(items: unknown[], total = items.length) {
  setLocale('zh-CN')
  api.getJson.mockResolvedValue({ items, total, nextCursor: null })
  const wrapper = mount(RecentNotices, { global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return wrapper
}

afterEach(() => api.getJson.mockReset())

describe('RecentNotices', () => {
  it('words each notice and gives it its own way in', async () => {
    const wrapper = await mountNotices([
      notice('topic_promoted', 'garden', { project: 'Garden' }, '/employees/assistant?promoted=garden&topic=Garden'),
      notice('model_failing', 'tonborg', { role: 'tonborg' }, '/models'),
      notice('unknown_kind', 'x', {}),
    ])
    const rows = wrapper.findAll('[data-notice]')
    expect(rows.map(row => row.attributes('data-notice'))).toEqual(['topic_promoted', 'model_failing'])
    expect(rows[0].text()).toContain('话题「Garden」聊得多，升级成了项目')
    expect(rows[0].text()).toContain('改名或撤销')
    expect(rows[0].getComponent(RouterLinkStub).props('to')).toBe('/employees/assistant?promoted=garden&topic=Garden')
    expect(rows[1].text()).toContain('Tonborg 的模型没回应')
  })

  it('leads a finished task retrospective to the lessons waiting in the review queue', async () => {
    const wrapper = await mountNotices([notice('retrospective_ready', 'task-a', { task: 'Synthetic task', project: 'Garden', lessons: 2 })])
    const row = wrapper.get('[data-notice="retrospective_ready"]')
    expect(row.text()).toContain('「Synthetic task」做完了，Astro 写了复盘，2 条经验等你确认')
    expect(row.text()).toContain('去确认')
    expect(row.getComponent(RouterLinkStub).props('to')).toBe('/inbox')
  })

  it('reads seven of the kinds it can word and links the rest to its own page', async () => {
    const wrapper = await mountNotices(Array.from({ length: 7 }, (_, i) => notice('fla_joined', `a${i}`, { name: `Synthetic ${i}`, project: 'Garden' })), 12)
    const url = new URL(api.getJson.mock.calls[0][0], 'http://fixture')
    expect(url.pathname).toBe('/api/notices')
    expect(url.searchParams.get('limit')).toBe('7')
    expect(url.searchParams.getAll('kind')).toContain('retrospective_ready')
    expect(wrapper.findAll('[data-notice]')).toHaveLength(7)
    const more = wrapper.findAllComponents(RouterLinkStub).find(link => link.attributes('data-workbench-more') === 'notices')!
    expect(more.text()).toBe('更多 5')
    expect(more.props('to')).toBe('/workbench/notices')
  })

  it('stays away when there is nothing to say or the read fails', async () => {
    expect((await mountNotices([])).find('[data-widget="recent-notices"]').exists()).toBe(false)
    setLocale('zh-CN')
    api.getJson.mockRejectedValue(new Error('offline'))
    const failed = mount(RecentNotices, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(failed.find('[data-widget="recent-notices"]').exists()).toBe(false)
  })
})

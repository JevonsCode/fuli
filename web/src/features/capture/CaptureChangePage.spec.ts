import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { useConsoleStore } from '@/stores/console'
import type { CaptureChangePreview } from './capture-change'
import CaptureChangePage from './CaptureChangePage.vue'

const PREVIEW: CaptureChangePreview = {
  status: 'pending',
  preview: '将把『求职准备』加入不记录列表，之后在这个项目里的会话都不会被记录，已有记录保留。确认吗？',
  sourceApplication: 'codex',
  sessionId: '0b4a0b9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  createdAt: '2026-10-21T08:00:00.000Z',
  expiresAt: '2026-10-21T08:30:00.000Z',
  current: { enabled: true, disabledSources: [], projectMode: 'all', excludedProjectIds: [], selectedProjectIds: [],
    unregisteredDirectories: 'capture' },
  changes: [
    { setting: 'projectMode', before: 'all', after: 'all_except' },
    { setting: 'excludedProjectIds', before: [], after: ['job-hunt'] },
  ],
}

// The console API for one previewed change: GET reads it, POST confirm/cancel answers as given.
function mountPage(read: () => Response, act: (action: string) => Response = () => Response.json({})) {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const action = url.split('/').at(-1)!
      posts.push(action)
      return act(action)
    }
    return url === '/api/capture-changes/synthetic-preview' ? read() : Response.json({}, { status: 404 })
  }))
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], projects: [], subscriptions: [],
    personalProjects: [{ project_id: 'job-hunt', personal_space_id: 'space', profile: { name: '求职准备' } }],
    capturePolicy: PREVIEW.current }
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/capture-change/:previewId', component: CaptureChangePage }, { path: '/settings', component: { template: '<div />' } }] })
  void router.push('/capture-change/synthetic-preview')
  return { mount: async () => { await router.isReady(); const wrapper = mount(CaptureChangePage, { global: { plugins: [pinia, router] } }); await flushPromises(); return wrapper }, posts, store }
}

describe('CaptureChangePage (rec#5 C4-2, rec#11 D-16)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows FULI\'s exact sentence, the change in names, the settings now and who asked', async () => {
    const page = mountPage(() => Response.json(PREVIEW))
    const wrapper = await page.mount()
    expect(wrapper.get('[data-capture-change-preview]').text()).toBe(PREVIEW.preview)
    expect(wrapper.get('[data-capture-change-setting="excludedProjectIds"]').text()).toContain('求职准备')
    expect(wrapper.get('[data-capture-change-setting="projectMode"]').text()).toContain('全部项目，除了没勾选的')
    expect(wrapper.text()).toContain('由 Codex 会话 0b4a0b9e… 发起')
    expect(wrapper.text()).toContain('Agent 无法替你确认')
    expect(page.posts).toEqual([])
  })

  it('applies the change once with an inline status, and the console keeps the saved settings', async () => {
    let answer!: (response: Response) => void
    const saved = { ...PREVIEW.current, projectMode: 'all_except' as const, excludedProjectIds: ['job-hunt'] }
    const page = mountPage(() => Response.json(PREVIEW), () => new Promise(resolve => { answer = resolve }) as never)
    const wrapper = await page.mount()
    await wrapper.get('[data-capture-change-confirm]').trigger('click')
    expect(wrapper.get('[data-capture-change-confirm]').text()).toContain('正在保存这次记录设置修改')
    expect(wrapper.get('[data-capture-change-cancel]').attributes('disabled')).toBeDefined()
    answer(Response.json(saved))
    await flushPromises()
    expect(page.posts).toEqual(['confirm'])
    expect(wrapper.get('[data-capture-change-outcome="saved"]').text()).toContain('已保存')
    expect(wrapper.find('[data-capture-change-confirm]').exists()).toBe(false)
    expect(page.store.state?.capturePolicy?.excludedProjectIds).toEqual(['job-hunt'])
  })

  it('says to ask again and writes nothing when the settings changed meanwhile', async () => {
    const page = mountPage(() => Response.json(PREVIEW),
      () => Response.json({ error: '设置已变化，请重新发起', code: 'preview_stale' }, { status: 409 }))
    const wrapper = await page.mount()
    await wrapper.get('[data-capture-change-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-capture-change-outcome="restart"]').text()).toContain('设置已变化，请重新发起')
    expect(wrapper.find('[data-capture-change-confirm]').exists()).toBe(false)
    expect(page.store.state?.capturePolicy).toEqual(PREVIEW.current)
  })

  it('shows a stale, used or expired request without a confirm button', async () => {
    const stale = await mountPage(() => Response.json({ ...PREVIEW, status: 'stale' })).mount()
    expect(stale.find('[data-capture-change-outcome="restart"]').exists()).toBe(true)
    expect(stale.find('[data-capture-change-confirm]').exists()).toBe(false)
    const gone = await mountPage(() => Response.json({ error: '设置已变化，请重新发起' }, { status: 410 })).mount()
    expect(gone.get('[data-capture-change-outcome="restart"]').text()).toContain('没有修改任何设置')
  })

  it('cancel writes nothing and says so', async () => {
    const page = mountPage(() => Response.json(PREVIEW), () => Response.json({ status: 'cancelled' }))
    const wrapper = await page.mount()
    await wrapper.get('[data-capture-change-cancel]').trigger('click')
    await flushPromises()
    expect(page.posts).toEqual(['cancel'])
    expect(wrapper.get('[data-capture-change-outcome="cancelled"]').text()).toBe('已取消，没有修改任何设置。')
    expect(page.store.state?.capturePolicy).toEqual(PREVIEW.current)
  })
})

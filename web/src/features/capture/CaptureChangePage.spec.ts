import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { useConsoleStore } from '@/stores/console'
import type { CapturePolicy } from '@/types'
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

// The console API for one previewed change: GET reads it, POST confirm/cancel answers as given,
// GET /api/capture-policy answers what is saved.
function mountPage(read: () => Response, act: (action: string) => Response = () => Response.json({}),
  saved: () => CapturePolicy = () => PREVIEW.current) {
  const posts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const action = url.split('/').at(-1)!
      posts.push(action)
      return act(action)
    }
    if (url === '/api/capture-policy') return Response.json(saved())
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

  it('shows an explicit client capture override in the change and current settings', async () => {
    const preview: CaptureChangePreview = { ...PREVIEW,
      current: { ...PREVIEW.current, disabledSources: ['other'], capturedSources: ['opencode'] },
      changes: [{ setting: 'capturedSources', before: [], after: ['opencode'] }],
    }
    const wrapper = await mountPage(() => Response.json(preview)).mount()
    const row = wrapper.get('[data-capture-change-setting="capturedSources"]')
    expect(row.text()).toContain('明确开启记录的客户端')
    expect(row.text()).toContain('OpenCode')
    expect(wrapper.text()).toContain('当前设置')
    wrapper.unmount()
  })

  it('says to ask again and writes nothing when the settings changed meanwhile', async () => {
    const page = mountPage(() => Response.json(PREVIEW),
      () => Response.json({ error: '设置已变化，请重新发起', code: 'preview_stale' }, { status: 409 }))
    const wrapper = await page.mount()
    await wrapper.get('[data-capture-change-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-capture-change-outcome="stale"]').text()).toContain('设置已变化，请重新发起')
    expect(wrapper.find('[data-capture-change-confirm]').exists()).toBe(false)
    expect(page.store.state?.capturePolicy).toEqual(PREVIEW.current)
  })

  it('shows a stale request without a confirm button', async () => {
    const stale = await mountPage(() => Response.json({ ...PREVIEW, status: 'stale' })).mount()
    expect(stale.find('[data-capture-change-outcome="stale"]').exists()).toBe(true)
    expect(stale.find('[data-capture-change-confirm]').exists()).toBe(false)
  })

  it('a confirm whose answer was lost shows what is saved; the used link never claims nothing changed (dot review, PR 262)', async () => {
    const applied = { ...PREVIEW.current, projectMode: 'all_except' as const, excludedProjectIds: ['job-hunt'] }
    let committed = false
    const page = mountPage(() => committed ? Response.json({ error: '设置已变化，请重新发起' }, { status: 410 })
      : Response.json(PREVIEW), () => {
      // The server commits, then the connection drops before the answer arrives.
      committed = true
      throw new TypeError('Failed to fetch')
    }, () => committed ? applied : PREVIEW.current)
    const wrapper = await page.mount()
    await wrapper.get('[data-capture-change-confirm]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-capture-change-outcome="unknown"]').text()).toContain('没能确认是否已保存')
    expect(wrapper.find('[data-capture-change-confirm]').exists()).toBe(false)
    expect(wrapper.get('[data-capture-change-current]').text()).toContain('求职准备')
    expect(wrapper.find('[data-capture-change-open-settings]').exists()).toBe(true)

    // Opened again, the used link answers 410: the page shows what is saved and promises nothing.
    const reopened = await mountPage(() => Response.json({ error: '设置已变化，请重新发起' }, { status: 410 }),
      () => Response.json({}), () => applied).mount()
    const notice = reopened.get('[data-capture-change-outcome="gone"]').text()
    expect(notice).toContain('这个请求已不能再使用')
    expect(notice).not.toContain('没有修改任何设置')
    expect(reopened.get('[data-capture-change-current]').text()).toContain('求职准备')
    expect(reopened.find('[data-capture-change-open-settings]').exists()).toBe(true)
  })

  it('a used link opened while a settings save is still out waits for it and shows what is saved (dot review, PR 262)', async () => {
    // The person turned 求职准备 back on in Settings; the server committed it, but its answer is late.
    let serverExcluded = ['job-hunt']
    let answerSave!: () => void
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/capture-policy' && init?.method === 'PATCH') {
        serverExcluded = []
        return new Promise<Response>(resolve => { answerSave = () => resolve(Response.json(policyWith(serverExcluded))) })
      }
      if (url === '/api/capture-policy') return Response.json(policyWith(serverExcluded))
      return Response.json({ error: '设置已变化，请重新发起' }, { status: 410 })
    }))
    const policyWith = (excluded: string[]): CapturePolicy => ({ ...PREVIEW.current, projectMode: 'all_except',
      excludedProjectIds: excluded })
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [{ id: 'space', name: '我' }], projects: [], subscriptions: [],
      personalProjects: [{ project_id: 'job-hunt', personal_space_id: 'space', profile: { name: '求职准备' } }],
      capturePolicy: policyWith(['job-hunt']) }
    const save = store.changeCapturePolicy({ recordProjects: { 'job-hunt': true } })
    await flushPromises()
    // Back on the used confirmation link while that answer is still out.
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/capture-change/:previewId', component: CaptureChangePage }, { path: '/settings', component: { template: '<div />' } }] })
    void router.push('/capture-change/synthetic-preview')
    await router.isReady()
    const wrapper = mount(CaptureChangePage, { global: { plugins: [pinia, router] } })
    await flushPromises()
    expect(wrapper.find('[data-capture-change-outcome="gone"]').exists()).toBe(true)
    expect(wrapper.find('[data-capture-change-reading]').exists()).toBe(true)
    // The old cache is not shown as the checked settings.
    expect(wrapper.find('[data-capture-change-current]').exists()).toBe(false)
    answerSave()
    await save
    await flushPromises()
    expect(wrapper.find('[data-capture-change-reading]').exists()).toBe(false)
    expect(wrapper.get('[data-capture-change-current]').text()).not.toContain('求职准备')
    expect(wrapper.get('[data-capture-change-current]').text()).toContain('全部项目，除了没勾选的')
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

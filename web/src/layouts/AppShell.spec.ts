import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getJson } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import AppShell from './AppShell.vue'
import { usePageTitle } from './page-title'
import { updateDocumentTitle } from '@/router/meta'

vi.mock('@/api/client', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
  patchJson: vi.fn(),
  postJson: vi.fn(),
  deleteJson: vi.fn(),
}))

let attentionTotal = 0
let pinnedIds: string[] = []

beforeEach(() => {
  attentionTotal = 0
  pinnedIds = []
  vi.mocked(getJson).mockReset()
  vi.mocked(getJson).mockImplementation(async (url: string) => {
    if (url.startsWith('/api/agent-attention?')) return { items: [], total: attentionTotal, counts: {} }
    if (url === '/api/agent-pins?personalSpaceId=personal-1') return { revision: 1, agentIds: pinnedIds }
    if (url === '/api/project-agents/agent-a?personalSpaceId=personal-1')
      return { agentId: 'agent-a', personalSpaceId: 'personal-1', profile: { name: 'Ada', displayName: 'Ada' } }
    if (url === '/api/system/version') return { status: 'unavailable', currentVersion: '0.20.0', latestVersion: null, updateAvailable: false, packageUrl: '', checkedAt: '' }
    throw new Error(`Unexpected request: ${url}`)
  })
})

async function setup(path: string, capabilities: Record<string, boolean> = {}, extraRoutes: RouteRecordRaw[] = []) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = {
    mode: 'personal_only',
    activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: '我' }],
    personalProjects: [],
    projects: [],
    subscriptions: [],
    capturePolicy: { enabled: false },
    agentAccessPolicy: { enabled: true },
    capabilities: { browsePublicProjects: false, submitKnowledge: false, reviewProposals: false, ...capabilities },
  } as never
  const page = { template: '<div class="routed-page" />' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...extraRoutes,
      { path: '/', component: page, meta: { title: '星图' } },
      { path: '/:pathMatch(.*)*', component: page, meta: { title: '页面' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppShell, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, store, router }
}

describe('AppShell', () => {
  it('names the memory destination once while the active tab names the page', async () => {
    const { wrapper, router } = await setup('/preferences')
    expect(wrapper.get('h1').text()).toBe('记忆')
    expect(wrapper.get('[data-section="preferences"]').attributes('aria-current')).toBe('page')
    expect(wrapper.find('[data-design-lab-open]').exists()).toBe(false)
    // An opened knowledge item is still inside 知识: the H1 does not repeat the tab.
    await router.push('/knowledge/personal/space-1/directory/entity/item-1')
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('记忆')
    expect(wrapper.get('[data-section="knowledge"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })
  it('keeps the floating design lab off conversation pages so it never covers a message', async () => {
    const { wrapper } = await setup('/roundtables/chat/room-1')
    expect(wrapper.find('[data-design-lab-open]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('marks the active destination and shows only the sections current capabilities allow', async () => {
    const { wrapper } = await setup('/preferences/writing')
    expect(wrapper.get('[data-destination="memory"]').attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('[data-section]').map(tab => tab.attributes('data-section'))).toEqual(['knowledge', 'preferences', 'writing', 'organize', 'tags'])
    expect(wrapper.get('[data-section="writing"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('adds public projects when the capabilities allow them; publishing decisions live there, not in memory', async () => {
    const { wrapper, router } = await setup('/public-projects', { browsePublicProjects: true, reviewProposals: true })
    expect(wrapper.findAll('[data-section]').map(tab => tab.attributes('data-section'))).toEqual(['myProjects', 'publicProjects'])
    await router.push('/organize')
    await flushPromises()
    expect(wrapper.findAll('[data-section]').map(tab => tab.attributes('data-section'))).not.toContain('review')
    wrapper.unmount()
  })

  it('names the destination, not the active tab, and keeps the 对话 heading on a selected conversation', async () => {
    const { wrapper, router } = await setup('/roundtables')
    expect(wrapper.get('.app-title').text()).toBe('对话')
    expect(wrapper.findAll('[data-section]').map(tab => tab.text())).toEqual(['圆桌', '待决策'])
    await router.push('/roundtables/thread-1')
    await flushPromises()
    expect(wrapper.get('.app-title').text()).toBe('对话')
    wrapper.unmount()
  })

  it('lists pinned Agents under Agents and marks the current one without tinting both rows', async () => {
    pinnedIds = ['agent-a']
    const { wrapper, router } = await setup('/agents/personal-1/agent-a')
    const pinned = wrapper.get('[data-pinned-agent="agent-a"]')
    expect(pinned.get('.pinned-rail-name').text()).toBe('Ada')
    expect(pinned.attributes('href')).toBe('/agents/personal-1/agent-a')
    expect(pinned.attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-destination="agents"]').classes()).toContain('has-active-child')
    await router.push('/project-agents')
    await flushPromises()
    expect(wrapper.get('[data-pinned-agent="agent-a"]').attributes('aria-current')).toBeUndefined()
    expect(wrapper.get('[data-destination="agents"]').classes()).not.toContain('has-active-child')
    wrapper.unmount()
  })

  it('keeps the version in the footer and names the service only when it is not ready', async () => {
    const { wrapper, store } = await setup('/')
    expect(wrapper.find('.nav-rail-brand [data-version]').exists()).toBe(false)
    expect(wrapper.get('.nav-rail-foot [data-version]').text()).toMatch(/^v[0-9]/)
    expect(wrapper.get('.nav-rail-runtime-text').classes()).not.toContain('is-visible')
    store.runtimeStatus = 'error'
    await flushPromises()
    expect(wrapper.get('.nav-rail-runtime-text').classes()).toContain('is-visible')
    expect(wrapper.find('.nav-rail-foot [data-version]').exists()).toBe(false)
    await wrapper.get('[data-nav-toggle]').trigger('click')
    expect(wrapper.get('nav').attributes('data-expanded')).toBe('false')
    expect(wrapper.get('[data-nav-toggle]').attributes('aria-label')).toBe('展开侧边栏')
    wrapper.unmount()
  })

  it('badges 对话 with the waiting count and hides the badge at zero', async () => {
    attentionTotal = 12
    const { wrapper } = await setup('/')
    expect(wrapper.get('[data-attention-badge]').text()).toBe('9+')
    wrapper.unmount()
    attentionTotal = 0
    const quiet = await setup('/')
    expect(quiet.wrapper.find('[data-attention-badge]').exists()).toBe(false)
    quiet.wrapper.unmount()
  })

  it('renders one H1: a record page names itself, the route title is only the fallback', async () => {
    const profile = defineComponent({ setup() { usePageTitle('Ada Lovelace'); return () => h('div', { class: 'routed-page' }) } })
    const { wrapper, router } = await setup('/agents/personal-1/agent-a', {}, [
      { path: '/agents/:spaceId/:agentId', component: profile, meta: { title: 'agentProfiles.profile', layout: 'canvas' } },
    ])
    expect(wrapper.findAll('h1').map(heading => heading.text())).toEqual(['Ada Lovelace'])
    expect(document.title).toBe('Ada Lovelace · 复利')
    // The app's router writes the route title after every navigation; a
    // query change (an in-page tab) must not leave the tab named after it.
    router.afterEach(to => updateDocumentTitle(to.meta.title))
    await router.replace({ query: { tab: 'history' } })
    await flushPromises()
    expect(document.title).toBe('Ada Lovelace · 复利')
    await router.push('/')
    await flushPromises()
    expect(wrapper.findAll('h1').map(heading => heading.text())).toEqual(['星图'])
    wrapper.unmount()
  })

  it('gives a detail page its own name alone: no section tabs beside it', async () => {
    const profile = defineComponent({ setup() { usePageTitle('Ada Lovelace'); return () => h('div', { class: 'routed-page' }) } })
    const { wrapper, router } = await setup('/agents/personal-1/agent-a', {}, [
      { path: '/agents/:spaceId/:agentId', component: profile, meta: { title: 'agentProfiles.profile', layout: 'canvas', detail: true } },
    ])
    expect(wrapper.get('h1').text()).toBe('Ada Lovelace')
    expect(wrapper.find('.section-tabs').exists()).toBe(false)
    // The rail still says where the page belongs.
    expect(wrapper.get('[data-destination="agents"]').classes()).toContain('is-active')
    await router.push('/project-agents')
    await flushPromises()
    expect(wrapper.findAll('[data-section]').length).toBeGreaterThan(1)
    wrapper.unmount()
  })

  it('refreshes the waiting requests from the top bar, so the inbox needs no refresh of its own', async () => {
    const { wrapper, store } = await setup('/')
    const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(undefined as never)
    const attentionReads = () => vi.mocked(getJson).mock.calls.filter(([url]) => String(url).startsWith('/api/agent-attention?')).length
    const before = attentionReads()
    await wrapper.get('[data-shell-refresh]').trigger('click'); await flushPromises()
    expect(refresh).toHaveBeenCalledOnce()
    expect(attentionReads()).toBeGreaterThan(before)
    wrapper.unmount()
  })

  it('keeps the floating design lab off pages with a sticky save bar', async () => {
    const { wrapper, router } = await setup('/settings', {}, [
      { path: '/settings', component: { template: '<div />' }, meta: { title: '设置', layout: 'form', saveBar: true } },
    ])
    expect(wrapper.find('[data-design-lab-open]').exists()).toBe(false)
    await router.push('/project-agents')
    await flushPromises()
    expect(wrapper.find('[data-design-lab-open]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('names section tabs by state words, never repeating the page title', async () => {
    const { wrapper } = await setup('/project-agents')
    expect(wrapper.get('h1').text()).toBe('Agents')
    expect(wrapper.findAll('[data-section]').map(tab => tab.text())).toEqual(['全部', '编排', '职业', '服务'])
    wrapper.unmount()
  })

  it('lines the top bar up with the canvas or form column of rebuilt pages only', async () => {
    const { wrapper, router } = await setup('/canvas', {}, [
      { path: '/canvas', component: { template: '<div />' }, meta: { title: '画布', layout: 'canvas' } },
      { path: '/form', component: { template: '<div />' }, meta: { title: '表单', layout: 'form' } },
    ])
    expect(wrapper.get('.app-main').attributes('data-layout')).toBe('canvas')
    await router.push('/form')
    await flushPromises()
    expect(wrapper.get('.app-main').attributes('data-layout')).toBe('form')
    await router.push('/')
    await flushPromises()
    expect(wrapper.get('.app-main').attributes('data-layout')).toBeUndefined()
    wrapper.unmount()
  })

  it('renders feedback and dismisses it from the close button', async () => {
    const { wrapper, store } = await setup('/')
    store.reportError(new Error('读取失败，请重试。'))
    await flushPromises()
    const feedback = wrapper.get('.feedback-message')
    expect(feedback.attributes('role')).toBe('alert')
    expect(feedback.text()).toContain('读取失败')
    await feedback.get('button').trigger('click')
    expect(wrapper.find('.feedback-message').exists()).toBe(false)
    wrapper.unmount()
  })
})

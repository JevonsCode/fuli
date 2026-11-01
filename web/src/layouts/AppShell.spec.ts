import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getJson } from '@/api/client'
import { findTerm } from '@/features/glossary/terms'
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
    if (url === '/api/project-agent-tasks?personalSpaceId=personal-1&agentId=agent-a&limit=200')
      return { tasks: [{ taskId: 't-1', personalSpaceId: 'personal-1', status: 'running', ownerAgentId: 'agent-a', participants: [] }] }
    if (url === '/api/agent-workflows?personalSpaceId=personal-1&agentId=agent-a') return { workflows: [] }
    if (url === '/api/system/doctor') return { checkedAt: '', version: '0.20.0', overall: 'ok', items: [], unchecked: [] }
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
    expect(wrapper.get('h1').text()).toBe('沉淀')
    expect(wrapper.get('[data-section="preferences"]').attributes('aria-current')).toBe('page')
    // An opened knowledge item is still inside 知识: the H1 does not repeat the tab.
    await router.push('/knowledge/personal/space-1/directory/entity/item-1')
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe('沉淀')
    expect(wrapper.get('[data-section="knowledge"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })
  it('marks the active destination and shows only the sections current capabilities allow', async () => {
    const { wrapper } = await setup('/preferences')
    expect(wrapper.get('[data-destination="memory"]').attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('[data-section]').map(tab => tab.attributes('data-section'))).toEqual(['knowledge', 'preferences', 'organize', 'tags'])
    expect(wrapper.get('[data-section="preferences"]').attributes('aria-current')).toBe('page')
    wrapper.unmount()
  })

  it('lets glossary mode explain every sidebar destination and section tab', async () => {
    const { wrapper, router } = await setup('/project-agents', { browsePublicProjects: true })
    const unexplained = (selector: string) => wrapper.findAll(selector)
      .filter(element => findTerm(element.element)?.element !== element.element)
      .map(element => element.attributes(selector.slice(1, -1)))
    expect(unexplained('[data-destination]')).toEqual([])
    for (const path of ['/project-agents', '/roundtables', '/public-projects', '/preferences', '/settings']) {
      await router.push(path)
      await flushPromises()
      expect(wrapper.findAll('[data-section]').length, path).toBeGreaterThan(1)
      expect(unexplained('[data-section]'), path).toEqual([])
    }
    // 设置 is both a destination and its first tab; each explains itself.
    expect(findTerm(wrapper.get('[data-destination="settings"]').element)?.term.id).toBe('destination.settings')
    expect(findTerm(wrapper.get('[data-section="settings"]').element)?.term.id).toBe('section.settings')
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

  it('names the destination, not the active tab, and keeps the 圆桌 heading on a selected conversation', async () => {
    const { wrapper, router } = await setup('/roundtables')
    expect(wrapper.get('.app-title').text()).toBe('圆桌')
    expect(wrapper.findAll('[data-section]').map(tab => tab.text())).toEqual(['讨论', '待决策'])
    await router.push('/roundtables/thread-1')
    await flushPromises()
    expect(wrapper.get('.app-title').text()).toBe('圆桌')
    wrapper.unmount()
  })

  it('puts the five main destinations in the dock in sketch order and settings in the top bar', async () => {
    const { wrapper, router } = await setup('/')
    const dock = wrapper.get('.app-dock')
    expect(dock.findAll('[data-destination]').map(link => link.attributes('data-destination'))).toEqual(['constellation', 'agents', 'chat', 'memory', 'projects'])
    expect(dock.findAll('[data-destination]').map(link => link.attributes('aria-label'))).toEqual(['工作台', 'FLAs', '圆桌', '沉淀', '项目'])
    expect(wrapper.get('.app-topbar [data-destination="settings"]').attributes('href')).toBe('/settings')
    // One ink pill sits behind the current destination and moves with it.
    expect(dock.findAll('.app-dock-active')).toHaveLength(1)
    expect(dock.find('.app-dock-item.is-active .app-dock-active').exists()).toBe(true)
    // Open on the workbench, folded to the current destination anywhere else.
    expect(dock.attributes('data-folded')).toBe('false')
    await router.push('/preferences')
    await flushPromises()
    expect(dock.attributes('data-folded')).toBe('true')
    expect(dock.findAll('.app-dock-active')).toHaveLength(1)
    expect(dock.find('.app-dock-item.is-active [data-destination="memory"]').exists()).toBe(true)
    // Settings is not in the dock: no current item to fold to, so it stays open.
    await router.push('/settings')
    await flushPromises()
    expect(dock.attributes('data-folded')).toBe('false')
    expect(dock.find('.app-dock-item.is-active').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows pinned FLAs above the FLAs button and marks the current one', async () => {
    pinnedIds = ['agent-a']
    const { wrapper, router } = await setup('/agents/personal-1/agent-a')
    const pinned = wrapper.get('.app-dock [data-pinned-agent="agent-a"]')
    expect(pinned.attributes('href')).toBe('/agents/personal-1/agent-a')
    expect(pinned.attributes('aria-label')).toContain('Ada')
    expect(pinned.attributes('aria-current')).toBe('page')
    await router.push('/project-agents')
    await flushPromises()
    expect(wrapper.get('[data-pinned-agent="agent-a"]').attributes('aria-current')).toBeUndefined()
    wrapper.unmount()
  })

  it('offers a pinned FLA its profile, its Workbench only when it has one, and unpinning from the right-click menu', async () => {
    pinnedIds = ['agent-a']
    const { wrapper } = await setup('/project-agents')
    await wrapper.get('[data-pinned-agent="agent-a"]').trigger('contextmenu', { clientX: 40, clientY: 600 })
    await flushPromises()
    const menu = document.querySelector('[data-pin-menu]')
    expect(menu?.textContent).toContain('Ada')
    const actions = () => [...document.querySelectorAll('[data-pin-action]')].map(item => item.getAttribute('data-pin-action'))
    expect(actions()).toEqual(['home', 'workbench', 'unpin'])
    wrapper.unmount()
  })

  it('shows the version on the service dot and names the service only when it is not ready', async () => {
    const { wrapper, store } = await setup('/')
    expect(wrapper.get('[data-runtime]').attributes('title')).toMatch(/ · v[0-9]/)
    expect(wrapper.get('.app-runtime-text').classes()).not.toContain('is-visible')
    store.runtimeStatus = 'error'
    await flushPromises()
    expect(wrapper.get('.app-runtime-text').classes()).toContain('is-visible')
    wrapper.unmount()
  })

  it('badges the waiting requests in the top bar and hides the badge at zero', async () => {
    attentionTotal = 12
    const { wrapper } = await setup('/')
    expect(wrapper.get('[data-attention-badge]').text()).toBe('9+')
    expect(wrapper.get('[data-shell-inbox]').attributes('aria-label')).toBe('12 件事在等你')
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

  it('leaves the H1 to a page that shows the name itself, keeping the tab title', async () => {
    const profile = defineComponent({ setup() {
      usePageTitle('Ada Lovelace', { inPage: true })
      return () => h('h1', { class: 'routed-page' }, 'Ada Lovelace')
    } })
    const { wrapper } = await setup('/agents/personal-1/agent-a', {}, [
      { path: '/agents/:spaceId/:agentId', component: profile, meta: { title: 'agentProfiles.profile', layout: 'canvas', detail: true } },
    ])
    expect(wrapper.find('.app-title').exists()).toBe(false)
    expect(wrapper.findAll('h1').map(heading => heading.text())).toEqual(['Ada Lovelace'])
    expect(document.title).toBe('Ada Lovelace · 复利')
    wrapper.unmount()
  })

  it('gives a detail page its own name alone: no section tabs beside it', async () => {
    const profile = defineComponent({ setup() { usePageTitle('Ada Lovelace'); return () => h('div', { class: 'routed-page' }) } })
    const { wrapper, router } = await setup('/agents/personal-1/agent-a', {}, [
      { path: '/agents/:spaceId/:agentId', component: profile, meta: { title: 'agentProfiles.profile', layout: 'canvas', detail: true } },
    ])
    expect(wrapper.get('h1').text()).toBe('Ada Lovelace')
    expect(wrapper.find('.section-tabs').exists()).toBe(false)
    // The dock still says where the page belongs.
    expect(wrapper.get('[data-destination="agents"]').attributes('aria-current')).toBe('page')
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

  it('names section tabs by state words, never repeating the page title', async () => {
    const { wrapper } = await setup('/project-agents')
    expect(wrapper.get('h1').text()).toBe('FLAs')
    expect(wrapper.findAll('[data-section]').map(tab => tab.text())).toEqual(['全部', '编排', '职业', '服务', '应用'])
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

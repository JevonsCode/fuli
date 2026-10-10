import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getJson } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import { FULI_VERSION } from '@/version'
import ConsoleLayout from './ConsoleLayout.vue'

vi.mock('@/api/client', () => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
  patchJson: vi.fn(),
  postJson: vi.fn(),
  deleteJson: vi.fn(),
}))

const roster = ['Bole', 'Jefa', 'Tonborg'].map((name) => ({
  agentId: `employee.${name.toLowerCase()}`,
  personalSpaceId: 'personal-1',
  profile: {
    name,
    responsibility: 'Synthetic role',
    capabilities: [],
    initialPreferences: [],
    status: 'active',
  },
}))

beforeEach(() => {
  vi.mocked(getJson).mockReset()
  vi.mocked(getJson).mockImplementation(async (url: string) => {
    if (url === '/api/project-agents?personalSpaceId=personal-1') return roster
    if (url === '/api/agent-pins?personalSpaceId=personal-1') return { revision: 1, agentIds: ['employee.bole', 'employee.jefa', 'employee.tonborg'] }
    if (url === '/api/system/version') return { status: 'unavailable', currentVersion: '0.12.0', latestVersion: null, updateAvailable: false, packageUrl: '', checkedAt: '' }
    throw new Error(`Unexpected detail request: ${url}`)
  })
})

describe('ConsoleLayout', () => {
  it('derives public destinations and settings navigation from current capabilities', async () => {
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
      capabilities: {
        browsePublicProjects: false,
        submitKnowledge: false,
        reviewProposals: false,
      },
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/',
        component: { template: '<div />' },
        meta: { title: '概览' },
      }, {
        path: '/settings',
        name: 'settings',
        component: { template: '<form id="settings-form"></form>' },
        meta: { title: '设置' },
      }, {
        path: '/:pathMatch(.*)*',
        component: { template: '<div />' },
      }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(ConsoleLayout, {
      attachTo: document.body,
      global: { plugins: [pinia, router] },
    })

    store.reportError(new Error('读取失败，请重试。'))
    await flushPromises()
    expect(wrapper.get('.feedback-message').element.tagName).toBe('DIV')
    await wrapper.get('.feedback-message > span').trigger('click')
    expect(store.feedback?.message).toBe('读取失败，请重试。')
    expect(wrapper.get('.feedback-dismiss').attributes('aria-label')).toBe('关闭')
    await wrapper.get('.feedback-dismiss').trigger('click')
    expect(store.feedback).toBeNull()

    const mobileMenu = wrapper.get('.mobile-nav-toggle')
    expect(mobileMenu.attributes('aria-expanded')).toBe('false')
    await mobileMenu.trigger('click')
    await flushPromises()
    expect(mobileMenu.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#console-primary-sidebar').classes()).toContain('is-mobile-open')
    expect(wrapper.get('main').attributes()).toHaveProperty('inert')
    expect(wrapper.find('.mobile-nav-backdrop').exists()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('.mobile-nav-close').element)
    expect(wrapper.get('.mobile-nav-close').text()).toBe('')
    expect(wrapper.get('.mobile-nav-close').attributes('aria-label')).toBe('关闭导航')
    expect(wrapper.get('.mobile-nav-close').attributes('title')).toBe('关闭导航')
    expect(wrapper.get('.mobile-nav-close-icon').attributes('aria-hidden')).toBe('true')
    await wrapper.get('.mobile-nav-backdrop').trigger('click')
    await flushPromises()
    expect(mobileMenu.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('main').attributes()).not.toHaveProperty('inert')
    expect(wrapper.find('.eyebrow').exists()).toBe(false)
    expect(document.activeElement).toBe(mobileMenu.element)
    expect(wrapper.find('a[href="/project-agents"]').exists()).toBe(true)

    expect(wrapper.get('.brand-version').text()).toBe(`v${FULI_VERSION}`)
    expect(wrapper.get('.nav-section-label').text()).toBe('更多')
    expect(wrapper.get('.nav-section-label').element.previousElementSibling?.classList.contains('pinned-agents-nav')).toBe(true)
    expect(wrapper.get('.pinned-agents-heading').text()).toBe('pin')
    expect(wrapper.get('a[href="/settings"]').text()).toContain('设置')
    expect(wrapper.get('a[href="/roundtables"]').text()).toContain('圆桌')
    expect(wrapper.get('a[href="/about"]').attributes('href')).toBe('/about')
    expect(wrapper.get('a[href="/project-agents"]').text()).toContain('Agents')
    expect(wrapper.findAll('.pinned-agent-name').map((name) => name.text())).toEqual(['Bole', 'Jefa', 'Tonborg'])
    expect(wrapper.find('a[href="/public-projects"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/review"]').exists()).toBe(false)
    store.state = {
      ...store.state,
      mode: 'connected',
      capabilities: {
        browsePublicProjects: true,
        submitKnowledge: true,
        reviewProposals: false,
      },
    }
    await flushPromises()

    expect(wrapper.find('a[href="/public-projects"]').exists()).toBe(true)
    expect(wrapper.find('a[href="/review"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('公共服务已连接')

    store.state = {
      ...store.state,
      capabilities: {
        browsePublicProjects: true,
        subscribeProject: true,
        publishProject: false,
        submitKnowledge: false,
        reviewProposals: false,
      },
    }
    await flushPromises()
    expect(wrapper.text()).toContain('公共项目发现与订阅可用')

    await router.push('/settings')
    await flushPromises()
    expect(wrapper.get('button[form="settings-form"]').text()).toContain('保存设置')
    expect(wrapper.get('button[form="settings-form"]').attributes('form')).toBe('settings-form')

    router.addRoute({
      path: '/employees/:templateId', component: { template: '<div>Agent board</div>' },
      meta: { title: '专属 Agent', dedicatedWorkspace: true },
    })
    await router.push('/employees/jefa')
    await flushPromises()
    expect(wrapper.get('.topbar').classes()).toContain('topbar--workbench')
    expect(wrapper.find('.topbar-heading').exists()).toBe(false)
    expect(wrapper.find('.topbar-actions').exists()).toBe(false)
    expect(wrapper.get('.mobile-nav-toggle').attributes('aria-controls')).toBe('console-primary-sidebar')
    expect(wrapper.text()).toContain('Agent board')
    wrapper.unmount()
  })

  it('surfaces a roster failure and retries both roster and pin reads', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [], projects: [], subscriptions: [],
    }
    let rosterReads = 0
    vi.mocked(getJson).mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=personal-1') {
        rosterReads += 1
        if (rosterReads === 1) throw new Error('Roster is temporarily unavailable.')
        return roster
      }
      if (url === '/api/agent-pins?personalSpaceId=personal-1') return { revision: 1, agentIds: [] }
      throw new Error(`Unexpected detail request: ${url}`)
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: { template: '<div />' } }],
    })
    await router.push('/')
    const wrapper = mount(ConsoleLayout, { global: { plugins: [pinia, router] } })
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('Roster is temporarily unavailable.')
    expect(wrapper.find('.pinned-agents-empty').exists()).toBe(false)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(rosterReads).toBe(2)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

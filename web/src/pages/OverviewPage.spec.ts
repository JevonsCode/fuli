import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it } from 'vitest'

import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import OverviewPage from './OverviewPage.vue'

describe('OverviewPage', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
  })

  it('shows the active personal space and uses status instead of a misleading public zero', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.runtimeStatus = 'ready'
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [
        { id: 'personal-1', name: '我' },
        { id: 'acceptance-space', name: '验收隔离空间' },
      ],
      personalProjects: Array.from({ length: 15 }, (_, index) => ({
        project_id: `project-${index}`,
        personal_space_id: 'personal-1',
        profile: { name: `项目 ${index}` },
      })),
      projects: [],
      subscriptions: [],
      providers: {
        personal: { status: 'ready' },
        workspaces: [],
      },
    }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: OverviewPage },
        { path: '/knowledge/:scope/:spaceId/:mode', component: { template: '<div />' } },
        { path: '/personal/:spaceId/projects/:mode', component: { template: '<div />' } },
        { path: '/connections', component: { template: '<div />' } },
        { path: '/public-projects', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(OverviewPage, { global: { plugins: [pinia, router] } })

    expect(wrapper.findAll('.overview-summary-card')).toHaveLength(3)
    expect(wrapper.get('.overview-space-card').text()).toContain('当前个人空间')
    expect(wrapper.get('.overview-space-card').text()).toContain('我')
    expect(wrapper.text()).not.toContain('验收隔离空间')
    expect(wrapper.get('.overview-space-card').attributes('href')).toBe(
      '/knowledge/personal/personal-1/directory',
    )
    expect(wrapper.get('.overview-personal-projects-card').text()).toContain('15')
    expect(wrapper.get('.overview-personal-projects-card').attributes('href')).toBe(
      '/personal/personal-1/projects/graph',
    )
    expect(wrapper.get('.overview-shared-projects-card').text()).toContain('未连接')
    expect(wrapper.get('.overview-shared-projects-card').text()).not.toContain('0')
    expect(wrapper.get('.overview-shared-projects-card').attributes('href')).toBe('/connections')

    store.state = {
      ...store.state,
      mode: 'connected',
      projects: [
        { id: 'shared-1', name: '共享一', providerUrl: 'https://provider.example' },
        { id: 'shared-2', name: '共享二', providerUrl: 'https://provider.example' },
        { id: 'shared-3', name: '共享三', providerUrl: 'https://provider.example' },
      ],
      subscriptions: [
        { project_id: 'shared-1', provider_url: 'https://provider.example' },
      ],
      providers: {
        personal: { status: 'ready' },
        workspaces: [{ status: 'ready', providerUrl: 'https://provider.example' }],
      },
    }
    await flushPromises()

    expect(wrapper.get('.overview-shared-projects-card').text()).toContain('3')
    expect(wrapper.get('.overview-shared-projects-card').text()).toContain('已订阅 1 个项目')
    expect(wrapper.get('.overview-shared-projects-card').attributes('href')).toBe('/public-projects')
  })
})

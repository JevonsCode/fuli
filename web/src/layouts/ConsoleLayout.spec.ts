import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import { FULI_VERSION } from '@/version'
import ConsoleLayout from './ConsoleLayout.vue'

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

    const mobileMenu = wrapper.get('.mobile-nav-toggle')
    expect(mobileMenu.attributes('aria-expanded')).toBe('false')
    await mobileMenu.trigger('click')
    await flushPromises()
    expect(mobileMenu.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('#console-primary-sidebar').classes()).toContain('is-mobile-open')
    expect(document.activeElement).toBe(wrapper.get('.mobile-nav-close').element)
    await wrapper.get('.mobile-nav-close').trigger('click')
    await flushPromises()
    expect(mobileMenu.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(mobileMenu.element)
    expect(wrapper.find('a[href="/project-agents"]').exists()).toBe(true)

    expect(wrapper.get('.brand-version').text()).toBe(`v${FULI_VERSION}`)
    expect(wrapper.get('.nav-about-label').text()).toBe('关于')
    expect(wrapper.get('.nav-about-label + a').attributes('href')).toBe('/settings')
    expect(wrapper.get('a[href="/about"]').attributes('href')).toBe('/about')
    expect(wrapper.get('a[href="/project-agents"]').text()).toContain('项目 Agent')
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
    expect(wrapper.get('.settings-save-button').text()).toContain('保存设置')
    expect(wrapper.get('.settings-save-button').attributes('form')).toBe('settings-form')
    wrapper.unmount()
  })
})

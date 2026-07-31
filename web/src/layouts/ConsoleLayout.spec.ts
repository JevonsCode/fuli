import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { describe, expect, it, vi } from 'vitest'

import { useConsoleStore } from '@/stores/console'
import ConsoleLayout from './ConsoleLayout.vue'

describe('ConsoleLayout', () => {
  it('derives public destinations and policy switches from current capabilities', async () => {
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
    const updateCapturePolicy = vi.spyOn(store, 'updateCapturePolicy')
      .mockResolvedValue(undefined)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{
        path: '/',
        component: { template: '<div />' },
        meta: { title: '概览' },
      }, {
        path: '/:pathMatch(.*)*',
        component: { template: '<div />' },
      }],
    })
    await router.push('/')
    await router.isReady()

    const wrapper = mount(ConsoleLayout, { global: { plugins: [pinia, router] } })

    expect(wrapper.find('a[href="/public-projects"]').exists()).toBe(false)
    expect(wrapper.find('a[href="/review"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="自动沉淀会话内容"]').attributes('aria-checked'))
      .toBe('false')

    await wrapper.get('[aria-label="自动沉淀会话内容"]').setValue(true)
    expect(updateCapturePolicy).toHaveBeenCalledWith(true)

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
    wrapper.unmount()
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import NavigationRecovery from '@/components/NavigationRecovery.vue'
import { setLocale } from '@/i18n'
import { installNavigationRecovery, navigationFailure } from './navigation-recovery'

afterEach(() => { navigationFailure.value = null })

describe('navigation recovery', () => {
  for (const error of [
    new TypeError('Failed to fetch dynamically imported module: /assets/previous.js'),
    new Error('Unable to preload CSS for /assets/previous.css'),
  ]) {
    it(`offers an explicit reload to the intended page: ${error.message}`, async () => {
      setLocale('zh-CN', { persist: false })
      const router = createRouter({ history: createMemoryHistory(), routes: [
        { path: '/', component: { template: '<div>Current page</div>' } },
        { path: '/employees/:templateId', component: async () => { throw error } },
      ] })
      const dispose = installNavigationRecovery(router)
      const wrapper = mount(NavigationRecovery)
      try {
        await router.push('/')
        const destination = '/employees/jefa?project=design#tasks'
        await expect(router.push(destination)).rejects.toThrow(error.message)
        await flushPromises()
        expect(router.currentRoute.value.path).toBe('/')
        expect(wrapper.get('[role="alert"]').text()).toContain('页面文件加载失败')
        expect(wrapper.get('a').attributes('href')).toBe(destination)
        expect(wrapper.get('a').text()).toBe('重新载入并打开')
        await wrapper.get('button').trigger('click')
        expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      } finally { wrapper.unmount(); dispose() }
    })
  }

  it('clears an earlier failure after another navigation succeeds', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: {} }, { path: '/working', component: {} },
      { path: '/broken', component: async () => { throw new Error('unexpected') } },
    ] })
    const dispose = installNavigationRecovery(router)
    try {
      await router.push('/')
      await expect(router.push('/broken')).rejects.toThrow('unexpected')
      expect(navigationFailure.value?.resourceFailure).toBe(false)
      await router.push('/working')
      expect(navigationFailure.value).toBeNull()
    } finally { dispose() }
  })
})

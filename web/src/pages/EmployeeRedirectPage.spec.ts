import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

import { useConsoleStore } from '@/stores/console'
import type { ConsoleState } from '@/types'
import EmployeeRedirectPage from './EmployeeRedirectPage.vue'

// /employees/<role> stays a working link: Jefa's runtime redirects to it.
describe('EmployeeRedirectPage', () => {
  it('lands on the role\'s FLA page once the space is known, keeping the link\'s query', async () => {
    setActivePinia(createPinia())
    const store = useConsoleStore()
    store.runtimeStatus = 'loading'
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/employees/:templateId', component: EmployeeRedirectPage },
      { path: '/agents/:spaceId/:agentId', component: { template: '<div />' } },
    ] })
    await router.push('/employees/jefa?project=project-a')
    mount(RouterView, { global: { plugins: [router] } })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/employees/jefa')
    store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic' }], personalProjects: [], projects: [], subscriptions: [] } as unknown as ConsoleState
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/agents/space-a/employee.jefa?project=project-a')
  })
})

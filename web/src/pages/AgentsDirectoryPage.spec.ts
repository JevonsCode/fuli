import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useConsoleStore } from '@/stores/console'
import AgentsDirectoryPage from './AgentsDirectoryPage.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson: vi.fn(), patchJson: vi.fn() }))
const mounted: Array<{ unmount: () => void }> = []
const roster = ['Aster', 'Birch'].map((name, index) => ({
  agentId: `agent-${index}`, personalSpaceId: 'space-a',
  profile: { name, responsibility: 'Synthetic review role', capabilities: ['review'], initialPreferences: [], status: 'active' },
}))
beforeEach(() => {
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = { mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }], personalProjects: [], projects: [], subscriptions: [] }
  store.runtimeStatus = 'ready'
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url === '/api/project-agents?personalSpaceId=space-a') return roster
    throw new Error(`Unexpected detail request: ${url}`)
  })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))
async function setup(path = '/project-agents') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/project-agents', component: AgentsDirectoryPage },
    { path: '/agents/:spaceId/:agentId', component: { template: '<div>Profile destination</div>' } },
    { path: '/employees/bole', component: { template: '<div />' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { router, wrapper }
}
describe('Agent directory integration', () => {
  it('loads only the roster and sends each name to its own profile', async () => {
    const { router, wrapper } = await setup()
    const links = wrapper.findAll('.agent-directory-name a')
    expect(links.map(link => [link.text(), link.attributes('href')])).toEqual([
      ['Aster', '/agents/space-a/agent-0'], ['Birch', '/agents/space-a/agent-1'],
    ])
    expect(getJson.mock.calls).toEqual([['/api/project-agents?personalSpaceId=space-a']])
    await links[0]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-0')
    await router.push('/project-agents')
    await flushPromises()
    await wrapper.findAll('.agent-directory-name a')[1]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')
    expect(getJson.mock.calls.every(([url]) => url === '/api/project-agents?personalSpaceId=space-a')).toBe(true)
  })

  it('preserves URL search and project filters during the initial space load', async () => {
    const store = useConsoleStore()
    const readyState = store.state!
    readyState.personalProjects = [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }]
    store.state = null; store.runtimeStatus = 'loading'
    getJson.mockImplementation(async (url: string) => {
      if (url === '/api/project-agents?personalSpaceId=space-a') return roster.map(item => ({ ...item, personalProjectId: 'project-a' }))
      throw new Error(`Unexpected request: ${url}`)
    })
    const { wrapper } = await setup('/project-agents?q=aster&project=project-a')
    store.state = readyState; store.runtimeStatus = 'ready'
    await flushPromises()
    expect((wrapper.get('input[type="search"]').element as HTMLInputElement).value).toBe('aster')
    expect(wrapper.findAll('.agent-directory-name a').map(link => link.text())).toEqual(['Aster'])
  })

  it('redirects a legacy agent query while preserving the remaining query', async () => {
    const { router } = await setup('/project-agents?agent=agent-1&project=project-a')
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-1')
    expect(router.currentRoute.value.query).toEqual({ project: 'project-a' })
  })
})

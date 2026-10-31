import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { forgetLoadedRosters } from '@/features/agent-profile/useAgentRosterPages'
import { useConsoleStore } from '@/stores/console'
import FlasPage from './FlasPage.vue'

const { getJson, putJson } = vi.hoisted(() => ({ getJson: vi.fn(), putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, putJson, postJson: vi.fn(), patchJson: vi.fn() }))

// Synthetic FLAs only: one per group, plus one on a project.
const fla = (index: number, name: string, extra: Record<string, unknown> = {}, status = 'active') => ({
  agentId: `agent-${index}`, personalSpaceId: 'space-a', employeeNumber: `00000${index}`,
  profile: { name, responsibility: `${name} looks after synthetic work`, capabilities: [], initialPreferences: [], status },
  ...extra,
})
const roster = [
  fla(1, 'Aster', { workStatus: 'idle' }),
  fla(2, 'Birch', { workStatus: 'blocked', currentTaskId: 'task-b' }),
  fla(3, 'Cedar', { workStatus: 'running', currentTaskId: 'task-c', assignments: [{ personalProjectId: 'project-a', status: 'active' }] }),
  // A state the console does not know is reported as unknown, never as free.
  fla(4, 'Dahlia', { workStatus: 'something-new' }),
  fla(5, 'Elm', { workStatus: 'running' }, 'archived'),
]
const mounted: Array<{ unmount: () => void }> = []

beforeEach(() => {
  forgetLoadedRosters()
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = {
    mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }],
    personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }], projects: [], subscriptions: [],
  } as never
  store.runtimeStatus = 'ready'
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agent-pages?')) return { items: url.includes('work=open') ? [] : roster, nextCursor: null, complete: true }
    if (url.startsWith('/api/project-agent-tasks?')) return []
    if (url.startsWith('/api/agent-pins?')) return { revision: 1, agentIds: ['agent-3'] }
    if (url.startsWith('/api/occupations')) return { occupations: [] }
    throw new Error(`Unexpected request: ${url}`)
  })
  putJson.mockReset()
  putJson.mockResolvedValue({ revision: 2, agentIds: ['agent-3', 'agent-1'] })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

async function setup(path = '/project-agents') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/project-agents', component: FlasPage },
    { path: '/project-agents/manage', component: { template: '<div>Manage</div>' } },
    { path: '/agents/:spaceId/:agentId', component: { template: '<div>Profile</div>' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { router, wrapper }
}
const groupNames = (wrapper: Awaited<ReturnType<typeof setup>>['wrapper']) =>
  wrapper.findAll('[data-flas-group]').map(group => [group.attributes('data-flas-group'), group.findAll('.fla-name').map(name => name.text())])

describe('FLAs page', () => {
  it('lists what needs the person first and never shows an unreported FLA as free', async () => {
    const { wrapper } = await setup()
    expect(groupNames(wrapper)).toEqual([
      ['attention', ['Birch']],
      ['working', ['Cedar']],
      ['idle', ['Aster']],
      ['unknown', ['Dahlia']],
      ['inactive', ['Elm']],
    ])
    expect(wrapper.get('[data-flas-group="attention"] .fla-work').text()).toContain('阻塞')
    // A free row says what the FLA is for; its heading already says free.
    expect(wrapper.get('[data-flas-group="idle"] .fla-work').text()).toBe('Aster looks after synthetic work')
  })

  it('opens an FLA by its whole row and marks pinned ones', async () => {
    const { router, wrapper } = await setup()
    const cedar = wrapper.get('[data-fla="agent-3"]')
    expect(cedar.attributes('href')).toBe('/agents/space-a/agent-3')
    expect(cedar.text()).toContain('已固定到 Dock')
    await cedar.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-3')
  })

  it('finds an FLA by name or number and keeps the search in the address', async () => {
    const { router, wrapper } = await setup('/project-agents?q=000002')
    expect(wrapper.findAll('.fla-name').map(name => name.text())).toEqual(['Birch'])
    await wrapper.get('[data-flas-search]').setValue('nobody')
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('nobody')
    expect(wrapper.get('[data-flas-no-match]').text()).toContain('nobody')
  })

  it('groups by project with the unassigned FLAs last, busiest first', async () => {
    const { router, wrapper } = await setup()
    await wrapper.get('[data-flas-view="projects"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.view).toBe('projects')
    expect(groupNames(wrapper)).toEqual([
      ['project-a', ['Cedar']],
      ['__none', ['Elm', 'Birch', 'Dahlia', 'Aster']],
    ])
  })

  it('pins from the row menu', async () => {
    const { wrapper } = await setup()
    await wrapper.get('[data-fla="agent-1"]').trigger('contextmenu')
    await flushPromises()
    const pin = document.querySelector<HTMLElement>('[data-fla-menu] [data-fla-action="pin"]')!
    expect(pin.textContent).toContain('固定到 Dock')
    pin.click()
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/agent-pins', expect.objectContaining({ agentId: 'agent-1', pinned: true, personalSpaceId: 'space-a' }))
  })

  it('sends a quick-look link from before the rewrite to the FLA page', async () => {
    const { router } = await setup('/project-agents?item=space-a/agent-2')
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent-2')
  })
})

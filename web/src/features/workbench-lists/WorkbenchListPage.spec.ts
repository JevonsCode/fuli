import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { openCombobox, toggleOption } from '@/test-support/option-pickers'
import WorkbenchListPage from './WorkbenchListPage.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic tasks, FLAs and notices only.
const task = (index: number, status = 'running') => ({
  task_id: `task-${index}`, personal_space_id: 'space-a', personal_project_id: 'project-a', title: `Synthetic task ${index}`,
  objective: 'Synthetic objective.', status, lead_agent_id: 'agent-1', participants: [],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-05T10:00:00Z', completed_at: status === 'completed' ? '2026-11-05T11:00:00Z' : null,
  result_summary: status === 'completed' ? `Synthetic result ${index}` : null,
})
const roster = [{ agentId: 'agent-1', personalSpaceId: 'space-a', profile: { name: 'Aster', responsibility: 'Synthetic.', capabilities: [], initialPreferences: [], status: 'active' } }]
const mounted: Array<{ unmount: () => void }> = []
const calls = () => getJson.mock.calls.map(([url]) => new URL(String(url), 'http://fixture'))
const pageCalls = (path: string) => calls().filter(url => url.pathname === path)

let tasks: (url: URL) => unknown
let notices: (url: URL) => unknown

beforeEach(() => {
  setLocale('zh-CN')
  setActivePinia(createPinia())
  const store = useConsoleStore()
  store.state = {
    mode: 'connected', activePersonalSpaceId: 'space-a', personalSpaces: [{ id: 'space-a', name: 'Synthetic space' }],
    personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: 'Synthetic project' } }], projects: [], subscriptions: [],
  } as never
  store.runtimeStatus = 'ready'
  tasks = (url) => (url.searchParams.get('cursor')
    ? { items: [task(50)], nextCursor: null, total: null }
    : { items: Array.from({ length: 50 }, (_, index) => task(index)), nextCursor: 'page-2', total: 51 })
  notices = () => ({ windowDays: 14, items: [], total: 0, nextCursor: null })
  getJson.mockReset()
  getJson.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://fixture')
    if (url.pathname === '/api/project-agents') return roster
    if (url.pathname === '/api/project-agent-task-pages') return tasks(url)
    if (url.pathname === '/api/notices') return notices(url)
    throw new Error(`Unexpected request: ${path}`)
  })
})
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

async function setup(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div>Today</div>' } },
    { path: '/workbench/:list(running|done|notices)', component: WorkbenchListPage },
    { path: '/project-agents/manage', component: { template: '<div>Task</div>' } },
  ] })
  await router.push(path)
  const wrapper = mount(RouterView, { attachTo: document.body, global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { router, wrapper }
}

describe('a workbench list on its own page', () => {
  it('reads the filters from the URL, shows the matching tasks and how many there are', async () => {
    const { wrapper } = await setup('/workbench/running?q=needle&status=blocked&project=project-a&fla=agent-1&quiet=1d&range=30d&sort=oldest')
    const [first] = pageCalls('/api/project-agent-task-pages')
    expect(first.searchParams.getAll('status')).toEqual(['blocked'])
    expect(first.searchParams.get('q')).toBe('needle')
    expect(first.searchParams.getAll('project')).toEqual(['project-a'])
    expect(first.searchParams.getAll('agent')).toEqual(['agent-1'])
    expect(first.searchParams.get('sort')).toBe('oldest')
    expect(first.searchParams.has('startedSince')).toBe(true)
    expect(first.searchParams.has('changedBefore')).toBe(true)
    expect(first.searchParams.get('limit')).toBe('50')
    expect(wrapper.get('[data-list-search]').element).toHaveProperty('value', 'needle')
    expect(wrapper.get('[data-workbench-list]').attributes('data-workbench-list')).toBe('running')
    expect(wrapper.find('[data-task-row]').text()).toContain('Synthetic task 0')
    expect(wrapper.find('[data-task-row]').text()).toContain('Aster · Synthetic project')
    expect(wrapper.text()).toContain('51 条')
    // The list's own filters fold behind one button that counts those in use.
    expect(wrapper.get('[data-list-filters]').text()).toBe('筛选 4')
    expect(wrapper.find('[data-list-extras]').exists()).toBe(false)
    expect(wrapper.get('[data-list-sort]').text()).toContain('最久没动静')
  })

  it('leads back to 今天', async () => {
    const { wrapper } = await setup('/workbench/running')
    const crumb = wrapper.get('nav a')
    expect(crumb.text()).toBe('今天')
    expect(crumb.attributes('href')).toBe('/')
  })

  it('unfolds the filters each list declares', async () => {
    const running = await setup('/workbench/running')
    await running.wrapper.get('[data-list-filters]').trigger('click')
    expect(running.wrapper.findAll('[data-list-filter]').map(field => field.attributes('data-list-filter'))).toEqual(['status', 'fla', 'project', 'quiet'])
    const done = await setup('/workbench/done')
    await done.wrapper.get('[data-list-filters]').trigger('click')
    expect(done.wrapper.findAll('[data-list-filter]').map(field => field.attributes('data-list-filter'))).toEqual(['status', 'fla', 'project', 'result', 'took'])
    const notices = await setup('/workbench/notices')
    await notices.wrapper.get('[data-list-filters]').trigger('click')
    expect(notices.wrapper.findAll('[data-list-filter]').map(field => field.attributes('data-list-filter'))).toEqual(['need', 'kind', 'project'])
  })

  it('puts a changed filter and the search in the URL and reads the first page again', async () => {
    const { router, wrapper } = await setup('/workbench/done')
    expect(pageCalls('/api/project-agent-task-pages')[0].searchParams.getAll('status')).toEqual(['completed'])
    await wrapper.get('[data-list-filters]').trigger('click')
    const status = wrapper.get('[data-list-filter="status"]')
    await openCombobox(status)
    await toggleOption(status, '已取消')
    expect(router.currentRoute.value.query.status).toEqual(['completed', 'cancelled'])
    expect(wrapper.get('[data-list-filters]').text()).toBe('筛选 1')
    await wrapper.get('[data-list-search]').setValue('needle')
    await new Promise(resolve => setTimeout(resolve, 350))
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('needle')
    const last = pageCalls('/api/project-agent-task-pages').at(-1)!
    expect(last.searchParams.get('q')).toBe('needle')
    expect(last.searchParams.getAll('status')).toEqual(['completed', 'cancelled'])
    expect(last.searchParams.get('order')).toBe('completed')
  })

  it('reads the next page when the drawn rows reach the end, once', async () => {
    const { wrapper } = await setup('/workbench/running')
    const list = wrapper.getComponent(VirtualDirectoryList)
    list.vm.$emit('nearEnd')
    list.vm.$emit('nearEnd')
    await flushPromises()
    const reads = pageCalls('/api/project-agent-task-pages')
    expect(reads.at(-1)!.searchParams.get('cursor')).toBe('page-2')
    expect(reads.filter(url => url.searchParams.get('cursor')).length).toBe(1)
    expect((list.props() as { items: unknown[] }).items).toHaveLength(51)
  })

  it('says nothing when a list is empty, and offers to clear filters that left nothing', async () => {
    tasks = () => ({ items: [], nextCursor: null, total: 0 })
    const plain = await setup('/workbench/running')
    expect(plain.wrapper.find('[data-list-none]').exists()).toBe(false)
    expect(plain.wrapper.findComponent(VirtualDirectoryList).exists()).toBe(false)
    const { router, wrapper } = await setup('/workbench/running?q=nothing')
    expect(wrapper.get('[data-list-none]').text()).toContain('没有符合条件的记录')
    await wrapper.get('[data-list-none] button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('shows what it is reading while the first page is on its way', async () => {
    tasks = () => new Promise(() => undefined)
    const { wrapper } = await setup('/workbench/running')
    expect(wrapper.get('[role="status"][aria-label]').attributes('aria-label')).toBe('正在读取「进行中」')
  })

  it('lists notices with their kinds, window and words', async () => {
    notices = () => ({ windowDays: 90, total: 1, nextCursor: null, items: [
      { id: 'fla_joined:a', kind: 'fla_joined', at: new Date().toISOString(), params: { name: 'Aster', project: 'Synthetic project' }, href: '/agents/space-a/agent-1' },
    ] })
    const { wrapper } = await setup('/workbench/notices?range=90d&kind=fla_joined')
    const [read] = pageCalls('/api/notices')
    expect(read.searchParams.get('days')).toBe('90')
    expect(read.searchParams.getAll('kind')).toEqual(['fla_joined'])
    expect(wrapper.get('[data-notice="fla_joined"]').text()).toContain('Aster 加入了「Synthetic project」')
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

import { designLab } from '@/features/design-lab/design-lab'
import { useAgentAttention, type AgentAttention } from '@/features/project-agents/attention-store'
import { setLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConsoleState, ProjectAgentTaskStatus } from '@/types'
import OverviewPage from './OverviewPage.vue'

const project = (id: string, name: string) => ({
  project_id: id,
  personal_space_id: 'space-a',
  profile: { name },
})

const task = (id: string, status: ProjectAgentTaskStatus, updatedAt: string, projectId: string) => ({
  task_id: id,
  personal_space_id: 'space-a',
  personal_project_id: projectId,
  title: `任务 ${id}`,
  status,
  updated_at: updatedAt,
  participants: [],
})

const attention = (id: string, taskId: string | null = null): AgentAttention => ({
  requestId: id,
  personalSpaceId: 'space-a',
  personalProjectId: 'project-a',
  agentId: `agent-${id}`,
  taskId,
  kind: 'question',
  title: `待处理 ${id}`,
  detail: '需要一个明确决定。',
  requestedAction: '请确认下一步。',
  revision: 1,
  status: 'open',
  createdAt: '2026-09-04T00:00:00Z',
})

function state(overrides: Partial<ConsoleState> = {}): ConsoleState {
  return {
    mode: 'personal_only',
    activePersonalSpaceId: 'space-a',
    personalSpaces: [{ id: 'space-a', name: '当前空间' }],
    personalProjects: [project('project-a', '项目 A'), project('project-b', '项目 B'), project('project-c', '项目 C')],
    projects: [],
    subscriptions: [],
    providers: { personal: { status: 'ready' }, workspaces: [] },
    ...overrides,
  }
}

// Pages read one Agent at a time: answer from a synthetic roster, 404 for anyone else.
const isAgentRead = (url: string) => url.startsWith('/api/project-agents/') && new URL(url, 'http://fixture').pathname.split('/').length === 4
function agentRead(url: string, roster: unknown[]) {
  const id = decodeURIComponent(new URL(url, 'http://fixture').pathname.split('/')[3] ?? '')
  const found = (roster as Array<{ agentId: string }>).find(agent => agent.agentId === id)
  return found ? Promise.resolve(found) : Promise.reject(Object.assign(new Error('project Agent not found'), { status: 404 }))
}
async function setup({
  taskPayload = { items: [] },
  attentionPayload = { items: [], total: 0, counts: {} },
  rosterPayload = [],
  initialState = state(),
  runtimeStatus = 'ready',
  getJsonImplementation,
}: {
  taskPayload?: unknown
  attentionPayload?: unknown
  rosterPayload?: unknown
  initialState?: ConsoleState | null
  runtimeStatus?: 'idle' | 'loading' | 'ready' | 'error'
  getJsonImplementation?: (url: string) => unknown
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const consoleStore = useConsoleStore()
  consoleStore.runtimeStatus = runtimeStatus
  consoleStore.state = initialState
  getJson.mockImplementation(getJsonImplementation
    ? async (url: string) => getJsonImplementation(url)
    : async (url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) return taskPayload
      if (url.startsWith('/api/agent-attention?')) return attentionPayload
      if (isAgentRead(url)) return agentRead(url, rosterPayload as unknown[])
      throw new Error(`Unexpected request: ${url}`)
    })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: OverviewPage },
      { path: '/inbox', component: { template: '<div />' } },
      { path: '/knowledge/:scope/:spaceId/:mode', component: { template: '<div />' } },
      { path: '/personal/:spaceId/projects/:mode', component: { template: '<div />' } },
      { path: '/personal/:spaceId/projects/:projectId/:mode', component: { template: '<div />' } },
      { path: '/connections', component: { template: '<div />' } },
      { path: '/project-agents/manage', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(OverviewPage, { global: { plugins: [pinia, router], stubs: { Workbench3D: { template: '<div data-testid="scene-stub" />' } } } })
  await flushPromises()
  return { wrapper, router, consoleStore, attentionStore: useAgentAttention() }
}

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
  designLab.value.workbench = 'current'
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
})

describe('OverviewPage', () => {
  afterEach(() => vi.useRealTimers())
  it('leads with one real open request, an owner, failed reason and safe next action', async () => {
    const row = { ...task('failed', 'failed', '2026-09-10T00:00:00Z', 'project-a'), lead_agent_id: 'owner', failure_reason: 'Source rejected this read' }
    const { wrapper } = await setup({ taskPayload: { items: [row] }, attentionPayload: { items: [attention('first'), attention('second'), { ...attention('closed'), status: 'resolved' }], total: 8, counts: {} }, rosterPayload: [{ agentId: 'owner', personalSpaceId: 'space-a', profile: { name: 'Mira Chen' } }] })
    expect(wrapper.findAll('[data-testid="overview-attention-item"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('请确认下一步。')
    expect(wrapper.text()).toContain('8')
    expect(wrapper.text()).toContain('负责人 Mira Chen')
    expect(wrapper.text()).toContain('Source rejected this read')
    expect(wrapper.text()).toContain('查看失败详情')
    expect(wrapper.text()).not.toContain('等你验收')
    wrapper.unmount()
  })

  it('clears private content and open excerpts on permission loss rather than keeping stale results', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [task('private', 'running', '2026-09-10T00:00:00Z', 'project-a')] }, attentionPayload: { items: [attention('private')], total: 1, counts: {} } })
    getJson.mockRejectedValue(Object.assign(new Error('private server body'), { status: 403 }))
    await wrapper.get('[data-testid="overview-work-retry"]').trigger('click'); await flushPromises()
    expect(wrapper.text()).not.toContain('任务 private')
    expect(wrapper.text()).not.toContain('待处理 private')
    expect(wrapper.text()).not.toContain('private server body')
    expect(wrapper.findAll('[data-testid="overview-current-work-item"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('访问权限已变化')
    wrapper.unmount()
  })

  it('prunes a successful project removal before another refresh fails and rejects late data for it', async () => {
    const { wrapper, consoleStore } = await setup({ taskPayload: { items: [task('private-project', 'running', '2026-09-10T00:00:00Z', 'project-a')] } })
    let resolve!: (value: unknown) => void
    getJson.mockImplementation(() => new Promise(done => { resolve = done }))
    await wrapper.get('[data-testid="overview-work-retry"]').trigger('click')
    consoleStore.state = state({ personalProjects: [project('project-b', '项目 B')] }); await flushPromises()
    expect(wrapper.text()).not.toContain('任务 private-project')
    resolve({ items: [task('late-private', 'running', '2026-09-10T00:00:00Z', 'project-a')] }); await flushPromises()
    expect(wrapper.text()).not.toContain('late-private')
    wrapper.unmount()
  })

  it('shows slow and timeout states without blocking a successful independent source', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const { wrapper } = await setup({ getJsonImplementation: url => {
      if (url.startsWith('/api/project-agent-tasks?')) return new Promise(done => { finish = done })
      if (url.startsWith('/api/agent-attention?')) return { items: [attention('ready')], total: 1, counts: {} }
      return {}
    } })
    expect(wrapper.text()).toContain('待处理 ready')
    await vi.advanceTimersByTimeAsync(8000)
    expect(wrapper.text()).toContain('读取时间较长')
    await vi.advanceTimersByTimeAsync(22000)
    expect(wrapper.text()).toContain('读取超时')
    expect(wrapper.get('[data-testid="overview-work-retry"]').attributes('disabled')).toBeUndefined()
    finish({ items: [task('late', 'running', '', 'project-a')] }); await flushPromises()
    expect(wrapper.text()).not.toContain('任务 late')
    wrapper.unmount()
  })
  it('starts narrow screens on list without overwriting a desktop office preference', async () => {
    designLab.value.workbench = 'office'
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    const { wrapper } = await setup({ taskPayload: { items: [task('t', 'running', '', 'project-a')] } })
    expect(wrapper.get('[role="combobox"]').text()).toBe('列表')
    expect(designLab.value.workbench).toBe('office')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('relation-weights'))).toBe(false)
    wrapper.unmount()
  })

  it('does not let a request from another project impersonate a task next step', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [task('same', 'awaiting_review', '', 'project-b')] }, attentionPayload: { items: [attention('wrong', 'same')], total: 1, counts: {} } })
    const row = wrapper.get('[data-testid="overview-current-work-item"]')
    expect(row.text()).toContain('查看交付记录')
    expect(row.get('a').attributes('href')).toContain('project=project-b&task=same')
    wrapper.unmount()
  })

  it('distinguishes an empty complete read from an empty partial read', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [], hasMore: true } })
    expect(wrapper.text()).toContain('部分记录')
    expect(wrapper.text()).not.toContain('当前范围暂无进行中的工作')
    wrapper.unmount()
  })

  it('keeps task content usable while owner names time out and retries names alone', async () => {
    vi.useFakeTimers()
    const { wrapper } = await setup({ getJsonImplementation: url => {
      if (url.startsWith('/api/project-agent-tasks?')) return { items: [{ ...task('readable', 'running', '', 'project-a'), lead_agent_id: 'slow-name' }] }
      if (url.startsWith('/api/agent-attention?')) return { items: [], total: 0 }
      return new Promise(() => {})
    } })
    expect(wrapper.text()).toContain('任务 readable')
    expect(wrapper.text()).toContain('正在读取负责人姓名')
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.text()).toContain('负责人姓名暂不可用')
    const taskCalls = getJson.mock.calls.filter(([url]) => String(url).includes('project-agent-tasks?')).length
    await wrapper.get('[role="alert"] button').trigger('click')
    expect(getJson.mock.calls.filter(([url]) => String(url).includes('project-agent-tasks?'))).toHaveLength(taskCalls)
    wrapper.unmount()
  })

  it('shows missing titles and owner values without replacing them with identifiers', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [
      { ...task('raw-id', 'blocked', '', 'project-a'), title: 'raw-id', objective: 'Actual objective' },
      { ...task('raw-uuid', 'queued', '', 'project-a'), title: 'raw-uuid' },
    ] } })
    expect(wrapper.text()).toContain('Actual objective')
    expect(wrapper.text()).toContain('未提供任务标题')
    expect(wrapper.text()).toContain('负责人未提供')
    expect(wrapper.text()).toContain('未提供原因')
    expect(wrapper.text()).not.toContain('raw-id')
    expect(wrapper.text()).not.toContain('raw-uuid')
    wrapper.unmount()
  })

  it('keeps the dashboard behind bootstrap loading until console state arrives', async () => {
    const { wrapper } = await setup({ initialState: null, runtimeStatus: 'loading' })

    expect(wrapper.get('.growth-loading--page').attributes('aria-label')).toBe('正在读取工作台范围…')
    expect(wrapper.find('.overview-content-grid').exists()).toBe(false)
  })

  it('restores the expanded read set after returning within the same space', async () => {
    const items = Array.from({ length: 8 }, (_, i) => task(`return-${i}`, 'running', '', 'project-a'))
    const first = await setup({ taskPayload: { items } })
    await first.wrapper.get('[aria-expanded="false"][data-slot="button"]').trigger('click')
    expect(first.wrapper.findAll('[data-testid="overview-current-work-item"]')).toHaveLength(8)
    first.wrapper.unmount()
    const second = await setup({ taskPayload: { items } })
    expect(second.wrapper.findAll('[data-testid="overview-current-work-item"]')).toHaveLength(8)
    await second.wrapper.get('[aria-expanded="true"][data-slot="button"]').trigger('click')
    second.wrapper.unmount()
  })

  it('clears the page as soon as a name read denies access even if another name hangs', async () => {
    const { wrapper } = await setup({ getJsonImplementation: url => {
      if (url.startsWith('/api/project-agent-tasks?')) return { items: [{ ...task('secret', 'running', '', 'project-a'), lead_agent_id: 'denied-owner' }] }
      if (url.startsWith('/api/agent-attention?')) return { items: [attention('slow-owner')], total: 1 }
      if (url.includes('denied-owner')) return Promise.reject(Object.assign(new Error('private'), { status: 403 }))
      return new Promise(() => {})
    } })
    expect(wrapper.text()).toContain('访问权限已变化')
    expect(wrapper.text()).not.toContain('任务 secret')
    wrapper.unmount()
  })

  it('shows real attention, current work, and recent projects with bounded previews', async () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, index) => task(`active-${index}`, 'running', `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`, index % 2 ? 'project-b' : 'project-a')),
      task('review', 'awaiting_review', '2026-09-20T00:00:00Z', 'project-c'),
      task('done', 'completed', '2026-09-21T00:00:00Z', 'project-a'),
    ]
    const pending = Array.from({ length: 6 }, (_, index) => attention(`request-${index}`, index === 0 ? 'task-0' : null))
    const { wrapper } = await setup({ taskPayload: { items: tasks }, attentionPayload: { items: pending, total: pending.length, counts: {} } })

    expect(wrapper.findAll('[data-testid="overview-attention-item"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="overview-current-work-item"]')).toHaveLength(6)
    expect(wrapper.get('[data-testid="overview-current-work-item"]').text()).toContain('任务 review')
    expect(wrapper.text()).not.toContain('任务 active-0')
    expect(wrapper.findAll('[data-testid="overview-recent-project"]')).toHaveLength(3)
    expect(wrapper.text()).toContain('项目 A')
    expect(wrapper.text()).toContain('项目 B')
    expect(wrapper.text()).toContain('项目 C')
    expect(wrapper.text()).not.toContain('数据流')
  })

  it('opens the exact attention queue and sends task links to management deep links', async () => {
    const pending = attention('request-a', 'task-a')
    const { wrapper, attentionStore } = await setup({
      taskPayload: { items: [task('task-a', 'running', '2026-09-10T00:00:00Z', 'project-a')] },
      attentionPayload: { items: [pending], total: 1, counts: { 'agent-request-a': 1 } },
    })

    // The inbox is a page: the item links to that Agent's queue with the request selected, no modal opens.
    expect(wrapper.get('[data-testid="overview-attention-open"]').attributes('href')).toBe('/inbox?agent=agent-request-a&request=request-a')
    expect(wrapper.get('[data-testid="overview-attention-all"]').attributes('href')).toBe('/inbox')
    expect(attentionStore.open).toBe(false)
    expect(wrapper.get('[data-testid="overview-attention-task"]').attributes('href')).toBe(
      '/project-agents/manage?agent=agent-request-a&project=project-a&task=task-a#task-task-a',
    )
  })

  it('uses available roster names and hides unavailable Agent identifiers', async () => {
    const { wrapper } = await setup({
      attentionPayload: {
        items: [attention('named'), attention('unknown')], total: 2, counts: {},
      },
      rosterPayload: [{
        agentId: 'agent-named', personalSpaceId: 'space-a',
        profile: { name: '内部名', displayName: 'Jefa' },
      }],
    })

    const rows = wrapper.findAll('[data-testid="overview-attention-item"]')
    expect(rows[0]!.text()).toContain('Agent Jefa')
    expect(rows[0]!.text()).not.toContain('agent-named')
    expect(wrapper.text()).not.toContain('agent-unknown')
    expect(rows[0]!.text()).toContain('项目 A')
  })

  it('marks a full task page as partial instead of claiming no active work', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => task(`done-${index}`, 'completed', '2026-09-10T00:00:00Z', 'project-a'))
    const { wrapper } = await setup({ taskPayload: { items: fullPage } })

    expect(wrapper.text()).toContain('部分记录')
    expect(wrapper.text()).not.toContain('暂无进行中的任务')
  })

  it('falls back to ordinary personal projects when tasks do not identify projects', async () => {
    const { wrapper } = await setup({
      taskPayload: { items: [task('no-project', 'running', '2026-09-10T00:00:00Z', '')] },
      initialState: state({ personalProjects: [project('project-a', '项目 A'), project('project-b', '项目 B')] }),
    })

    expect(wrapper.findAll('[data-testid="overview-recent-project"]')).toHaveLength(2)
    expect(wrapper.text()).toContain('项目 A')
    expect(wrapper.text()).toContain('项目 B')
  })

  it('keeps loaded work visible when a refresh fails and offers retry', async () => {
    const { wrapper } = await setup({
      taskPayload: { items: [task('kept', 'running', '2026-09-10T00:00:00Z', 'project-a')] },
    })
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) throw new Error('tasks offline')
      if (url.startsWith('/api/agent-attention?')) return { items: [], total: 0, counts: {} }
      throw new Error(`Unexpected request: ${url}`)
    })
    await wrapper.get('[data-testid="overview-work-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('任务 kept')
    expect(wrapper.get('[role="alert"]').text()).toContain('更新失败，显示上次结果')
  })

  it('ignores a late task response from a previous personal space', async () => {
    let resolveFirst!: (value: unknown) => void
    const first = new Promise(resolve => { resolveFirst = resolve })
    const { wrapper, consoleStore } = await setup({
      getJsonImplementation: (url: string) => {
        if (url.startsWith('/api/project-agent-tasks?') && url.includes('space-a')) return first
        if (url.startsWith('/api/project-agent-tasks?')) return Promise.resolve({ items: [{ ...task('space-b-task', 'running', '2026-09-11T00:00:00Z', 'project-b'), personal_space_id: 'space-b' }] })
        if (url.startsWith('/api/agent-attention?')) return Promise.resolve({ items: [], total: 0, counts: {} })
        throw new Error(`Unexpected request: ${url}`)
      },
    })
    consoleStore.state = state({
      activePersonalSpaceId: 'space-b',
      personalSpaces: [{ id: 'space-a', name: '旧空间' }, { id: 'space-b', name: '新空间' }],
      personalProjects: [{ ...project('project-b', '项目 B'), personal_space_id: 'space-b' }],
    })
    await flushPromises()
    resolveFirst({ items: [task('late-space-a', 'running', '2026-09-12T00:00:00Z', 'project-a')] })
    await flushPromises()

    expect(wrapper.text()).toContain('任务 space-b-task')
    expect(wrapper.text()).not.toContain('任务 late-space-a')
  })
})

const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
it('does not let timed-out bootstrap overwrite the successful retry scope', async () => {
  vi.useFakeTimers()
  const old = deferred(), fresh = deferred(); let reads = 0
  const { wrapper, consoleStore } = await setup({initialState:null, runtimeStatus:'idle', getJsonImplementation: url => {
    if(url === '/api/state') return ++reads === 1 ? old.promise : fresh.promise
    if(url.startsWith('/api/project-agent-tasks?')) return {items:[]}
    if(url.startsWith('/api/agent-attention?')) return {items:[],total:0}
    return Promise.reject(Object.assign(new Error('missing'), {status:404}))
  }})
  await vi.advanceTimersByTimeAsync(30001); await flushPromises()
  await wrapper.get('.overview-scope-error button').trigger('click')
  const freshState=state({activePersonalSpaceId:'space-b',personalSpaces:[{id:'space-b',name:'Fresh scope'}],personalProjects:[]})
  fresh.resolve(freshState); await flushPromises()
  expect(consoleStore.activePersonalSpace?.id).toBe('space-b')
  old.resolve(state()); await flushPromises()
  const finalSpace=consoleStore.activePersonalSpace?.id
  wrapper.unmount()
  expect(finalSpace).toBe('space-b')
})
it('restarts pending reads after authoritative project shrink', async () => {
  const pendingTasks=deferred(), pendingRequests=deferred()
  const { wrapper, consoleStore } = await setup({getJsonImplementation:url=> {
    if(url.startsWith('/api/project-agent-tasks?')) return pendingTasks.promise
    if(url.startsWith('/api/agent-attention?')) return pendingRequests.promise
    return Promise.reject(Object.assign(new Error('missing'), {status:404}))
  }})
  consoleStore.state=state({personalProjects:[project('project-b','项目 B')]})
  await flushPromises()
  pendingTasks.resolve({items:[task('kept','running','2026-09-10T00:00:00Z','project-b')]})
  pendingRequests.resolve({items:[{...attention('kept'),personalProjectId:'project-b'}],total:1})
  await flushPromises()
  const html=wrapper.text()
  const calls=getJson.mock.calls.map(call=>call[0])
  wrapper.unmount()
  expect({task:html.includes('任务 kept'),request:html.includes('待处理 kept'),taskReads:calls.filter(u=>u.startsWith('/api/project-agent-tasks?')).length,requestReads:calls.filter(u=>u.startsWith('/api/agent-attention?')).length}).toEqual({task:true,request:true,taskReads:2,requestReads:2})
})

it('provides an equivalent outside-scene link for each request-only member', async () => {
  designLab.value.workbench='office'
  const {wrapper}=await setup({taskPayload:{items:[{...task('working','running','2026-09-10T00:00:00Z','project-a'),lead_agent_id:'owner'}]},attentionPayload:{items:[attention('first'),attention('second')],total:2}})
  const links=wrapper.findAll('a').map(link=>link.attributes('href'))
  wrapper.unmount()
  expect(links.some(href=>href?.includes('request=first'))).toBe(true)
  expect(links.some(href=>href?.includes('request=second'))).toBe(true)
})

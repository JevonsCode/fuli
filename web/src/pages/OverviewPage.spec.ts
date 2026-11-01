import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

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
  const wrapper = mount(OverviewPage, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router, consoleStore, attentionStore: useAgentAttention() }
}

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
})

describe('OverviewPage', () => {
  it('stages the first current task and moves a picked task out of the column', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [
      task('first', 'running', '2026-09-12T00:00:00Z', 'project-a'),
      task('second', 'running', '2026-09-11T00:00:00Z', 'project-a'),
    ] } })
    expect(wrapper.get('[data-workbench-stage]').text()).toContain('任务 first')
    expect(wrapper.get('[data-workbench-pick]').text()).toContain('任务 second')
    await wrapper.get('[data-workbench-pick]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-workbench-stage]').text()).toContain('任务 second')
    expect(wrapper.get('[data-workbench-running]').text()).not.toContain('任务 second')
    expect(wrapper.get('[data-workbench-pick]').text()).toContain('任务 first')
    wrapper.unmount()
  })

  it('shows waiting only for open requests and orders completed work newest first', async () => {
    const empty = await setup()
    expect(empty.wrapper.find('[data-workbench-waiting]').exists()).toBe(false)
    empty.wrapper.unmount()
    const { wrapper } = await setup({
      attentionPayload: { items: [attention('open'), { ...attention('closed'), status: 'resolved' }], total: 1 },
      taskPayload: { items: [task('older', 'completed', '2026-09-01T00:00:00Z', 'project-a'), task('newer', 'completed', '2026-09-02T00:00:00Z', 'project-a')] },
    })
    expect(wrapper.findAll('[data-workbench-request]')).toHaveLength(1)
    expect(wrapper.get('[data-workbench-waiting]').text()).toContain('待处理 open')
    const done = wrapper.findAll('[data-workbench-done] li').map(row => row.text())
    expect(done[0]).toContain('任务 newer')
    expect(done[1]).toContain('任务 older')
    wrapper.unmount()
  })

  it('shows participant completion in the stage arc', async () => {
    const row = { ...task('progress', 'running', '', 'project-a'), participants: [
      { agent_id: 'one', role: 'member', status: 'completed' },
      { agent_id: 'two', role: 'member', status: 'running' },
      { agent_id: 'three', role: 'member', status: 'completed' },
    ] }
    const { wrapper } = await setup({ taskPayload: { items: [row] } })
    expect(wrapper.get('.fla-arc').attributes('aria-label')).toBe('2/3 位 FLA 已完成分工')
    expect(wrapper.findAll('.fla-arc-segment.is-done')).toHaveLength(2)
    wrapper.unmount()
  })

  it('links the next action to the matching open request or the task', async () => {
    const row = task('selected', 'running', '', 'project-a')
    const { wrapper } = await setup({ taskPayload: { items: [row] }, attentionPayload: { items: [attention('question', 'selected')], total: 1 } })
    expect(wrapper.get('[data-workbench-next]').attributes('href')).toBe('/inbox?agent=agent-question&request=question')
    wrapper.unmount()
    const fallback = await setup({ taskPayload: { items: [row] } })
    expect(fallback.wrapper.get('[data-workbench-next]').attributes('href')).toBe('/project-agents/manage?project=project-a&task=selected#task-selected')
    fallback.wrapper.unmount()
  })

  it('clears private content and open excerpts on permission loss rather than keeping stale results', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [task('private', 'running', '2026-09-10T00:00:00Z', 'project-a')] }, attentionPayload: { items: [attention('private')], total: 1, counts: {} } })
    getJson.mockRejectedValue(Object.assign(new Error('private server body'), { status: 403 }))
    await (wrapper.vm as any).data.loadTasks(); await flushPromises()
    expect(wrapper.text()).not.toContain('任务 private')
    expect(wrapper.text()).not.toContain('待处理 private')
    expect(wrapper.text()).not.toContain('private server body')
    expect(wrapper.findAll('[data-workbench-pick]')).toHaveLength(0)
    expect(wrapper.text()).toContain('访问权限已变化')
    wrapper.unmount()
  })


  it('prunes a successful project removal before another refresh fails and rejects late data for it', async () => {
    const { wrapper, consoleStore } = await setup({ taskPayload: { items: [task('private-project', 'running', '2026-09-10T00:00:00Z', 'project-a')] } })
    let resolve!: (value: unknown) => void
    getJson.mockImplementation(() => new Promise(done => { resolve = done }))
    void (wrapper.vm as any).data.loadTasks()
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
    expect(wrapper.get('[data-workbench-running] [role="alert"] button').attributes('disabled')).toBeUndefined()
    finish({ items: [task('late', 'running', '', 'project-a')] }); await flushPromises()
    expect(wrapper.text()).not.toContain('任务 late')
    wrapper.unmount()
  })

  it('does not let a request from another project impersonate a task next step', async () => {
    const { wrapper } = await setup({ taskPayload: { items: [task('same', 'awaiting_review', '', 'project-b')] }, attentionPayload: { items: [attention('wrong', 'same')], total: 1, counts: {} } })
    const row = wrapper.get('[data-workbench-stage]')
    expect(row.text()).toContain('查看交付记录')
    expect(row.get('a').attributes('href')).toContain('project=project-b&task=same')
    wrapper.unmount()
  })


  it('distinguishes an empty complete read from an empty partial read', async () => {
    const complete = await setup()
    expect(complete.wrapper.text()).toContain('当前范围暂无进行中的工作')
    complete.wrapper.unmount()
    const { wrapper } = await setup({ taskPayload: { items: [], hasMore: true } })
    expect(wrapper.text()).toContain('部分记录')
    expect(wrapper.text()).not.toContain('当前范围暂无进行中的工作')
    wrapper.unmount()
  })


  it('keeps task content usable while owner names time out', async () => {
    vi.useFakeTimers()
    const { wrapper } = await setup({ getJsonImplementation: url => {
      if (url.startsWith('/api/project-agent-tasks?')) return { items: [{ ...task('readable', 'running', '', 'project-a'), lead_agent_id: 'slow-name' }] }
      if (url.startsWith('/api/agent-attention?')) return { items: [], total: 0 }
      return new Promise(() => {})
    } })
    expect(wrapper.text()).toContain('任务 readable')
    // With nothing recorded yet, each FLA's share (with the owner's name) is the stage's only view.
    expect(wrapper.find('[data-workbench-timeline]').exists()).toBe(false)
    expect(wrapper.find('[data-workbench-stage] .ui-segmented').exists()).toBe(false)
    expect(wrapper.text()).toContain('正在读取负责人姓名')
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.text()).toContain('负责人姓名暂不可用')
    expect(wrapper.get('[data-workbench-next]').attributes('href')).toContain('task=readable')
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
    expect(wrapper.text()).not.toContain('raw-id')
    expect(wrapper.text()).not.toContain('raw-uuid')
    wrapper.unmount()
  })


  it('keeps the dashboard behind bootstrap loading until console state arrives', async () => {
    const { wrapper } = await setup({ initialState: null, runtimeStatus: 'loading' })

    expect(wrapper.get('.growth-loading--page').attributes('aria-label')).toBe('正在读取工作台范围…')
    expect(wrapper.find('[data-workbench-feed]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a slow scope and times out without accepting a late bootstrap result', async () => {
    vi.useFakeTimers()
    let finish!: (value: unknown) => void
    const { wrapper } = await setup({ initialState: null, runtimeStatus: 'idle', getJsonImplementation: url => {
      if (url === '/api/state') return new Promise(done => { finish = done })
      if (url.startsWith('/api/project-agent-tasks?')) return { items: [] }
      if (url.startsWith('/api/agent-attention?')) return { items: [], total: 0 }
      throw new Error('Unexpected request')
    } })
    await vi.advanceTimersByTimeAsync(8000)
    expect(wrapper.text()).toContain('读取时间较长')
    await vi.advanceTimersByTimeAsync(22001)
    expect(wrapper.text()).toContain('读取超时')
    expect(wrapper.get('.overview-scope-error button').attributes('disabled')).toBeUndefined()
    finish(state()); await flushPromises()
    expect(wrapper.text()).toContain('读取超时')
    wrapper.unmount()
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


  it('keeps loaded work visible when a refresh fails and offers retry', async () => {
    const { wrapper } = await setup({
      taskPayload: { items: [task('kept', 'running', '2026-09-10T00:00:00Z', 'project-a')] },
    })
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agent-tasks?')) throw new Error('tasks offline')
      if (url.startsWith('/api/agent-attention?')) return { items: [], total: 0, counts: {} }
      throw new Error(`Unexpected request: ${url}`)
    })
    await (wrapper.vm as any).data.loadTasks()
    await flushPromises()

    expect(wrapper.text()).toContain('任务 kept')
    expect(wrapper.get('[role="alert"]').text()).toContain('更新失败，显示上次结果')
    expect(wrapper.get('[data-workbench-running] [role="alert"] button').text()).toContain('重新读取')
    wrapper.unmount()
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

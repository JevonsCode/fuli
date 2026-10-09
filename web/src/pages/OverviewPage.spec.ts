import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
      if (url.startsWith('/api/project-agents?')) return rosterPayload
      throw new Error(`Unexpected request: ${url}`)
    })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: OverviewPage },
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

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
})

describe('OverviewPage', () => {
  it('keeps the dashboard behind bootstrap loading until console state arrives', async () => {
    const { wrapper } = await setup({ initialState: null, runtimeStatus: 'loading' })

    expect(wrapper.get('.growth-loading--page').attributes('aria-label')).toBe('正在读取空间与服务状态…')
    expect(wrapper.find('.overview-content-grid').exists()).toBe(false)
  })

  it('shows real attention, current work, and recent projects with bounded previews', async () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, index) => task(`active-${index}`, 'running', `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00Z`, index % 2 ? 'project-b' : 'project-a')),
      task('review', 'awaiting_review', '2026-09-20T00:00:00Z', 'project-c'),
      task('done', 'completed', '2026-09-21T00:00:00Z', 'project-a'),
    ]
    const pending = Array.from({ length: 6 }, (_, index) => attention(`request-${index}`, index === 0 ? 'task-0' : null))
    const { wrapper } = await setup({ taskPayload: { items: tasks }, attentionPayload: { items: pending, total: pending.length, counts: {} } })

    expect(wrapper.findAll('[data-testid="overview-attention-item"]')).toHaveLength(5)
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

    await wrapper.get('[data-testid="overview-attention-open"]').trigger('click')
    expect(attentionStore.open).toBe(true)
    expect(attentionStore.agentId).toBe('agent-request-a')
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
    expect(rows[1]!.text()).not.toContain('agent-unknown')
    expect(rows[1]!.text()).toContain('项目 A')
  })

  it('marks a full task page as partial instead of claiming no active work', async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) => task(`done-${index}`, 'completed', '2026-09-10T00:00:00Z', 'project-a'))
    const { wrapper } = await setup({ taskPayload: { items: fullPage } })

    expect(wrapper.text()).toContain('部分工作记录暂时无法读取')
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
    expect(wrapper.get('[role="alert"]').text()).toContain('tasks offline')
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
      personalProjects: [project('project-b', '项目 B')],
    })
    await flushPromises()
    resolveFirst({ items: [task('late-space-a', 'running', '2026-09-12T00:00:00Z', 'project-a')] })
    await flushPromises()

    expect(wrapper.text()).toContain('任务 space-b-task')
    expect(wrapper.text()).not.toContain('任务 late-space-a')
  })
})

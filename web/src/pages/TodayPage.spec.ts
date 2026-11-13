import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))
// The habits waiting to be confirmed: the same list the top bar counts, stubbed to a number.
const review = vi.hoisted(() => ({ store: null as null | { total: number; loaded: boolean; error: string; items: unknown[] } }))
vi.mock('@/features/review-list/review-store', async () => {
  const { reactive } = await import('vue')
  const store = reactive({ items: [] as unknown[], total: 0, loaded: true, error: '', setSpace: () => {}, refresh: async () => {} })
  review.store = store
  return { useReviewList: () => store }
})

import { ApiError } from '@/api/client'
import { forgetTeamWork } from '@/features/team-work/useTeamWork'
import { setLocale } from '@/i18n'
import { router as appRouter } from '@/router'
import { useConsoleStore } from '@/stores/console'
import type { ConsoleState } from '@/types'
import TodayPage from './TodayPage.vue'
import WorkbenchPage from './WorkbenchPage.vue'

const state = (): ConsoleState => ({
  mode: 'personal_only',
  activePersonalSpaceId: 'space-a',
  personalSpaces: [{ id: 'space-a', name: '当前空间' }],
  personalProjects: [{ project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '项目 A' } }],
  projects: [],
  subscriptions: [],
  providers: { personal: { status: 'ready' }, workspaces: [] },
})
const request = (id: string) => ({
  requestId: id, personalSpaceId: 'space-a', personalProjectId: 'project-a', agentId: `agent-${id}`, taskId: null, kind: 'question',
  title: `问题 ${id}`, detail: '', requestedAction: '请确认', revision: 1, status: 'open', createdAt: new Date().toISOString(),
})
const notice = (id: string, at: Date) => ({ id, kind: 'tonborg_confirmed', at: at.toISOString(), params: { count: 2 }, href: '/inbox' })
const task = (id: string, status: string) => ({
  task_id: id, personal_space_id: 'space-a', personal_project_id: 'project-a', title: `任务 ${id}`, status,
  lead_agent_id: 'agent-lead', updated_at: '2026-11-13T08:00:00Z', participants: [],
})
const statement = (overrides: Record<string, unknown> = {}) => ({
  window: { from: 'x', to: 'y' }, total: { confirmed: 42 }, series: [{ to: '2026-11-02', confirmed: 30 }, { to: '2026-11-09', confirmed: 42 }],
  carried: { tasks: 12, clients: 3, items: 40 }, used: { times: 7, tasks: 5, cited: 4, applied: 3 },
  learned: { captured: 6, confirmedByYou: 4, confirmedByTonborg: 2, promotedByUse: 0, retired: 1 },
  decided: { forYou: 2, undone: 0 }, changed: { forYou: 1 }, done: { finished: 3, failed: 1 }, answered: { questions: 2 }, unavailable: [],
  ...overrides,
})

interface Fixture {
  requests?: unknown[]; requestTotal?: number; notices?: unknown[]; tasks?: unknown[]; statement?: unknown; reviewTotal?: number
  statementRead?: () => Promise<unknown>
}
const mounted: VueWrapper[] = []
async function setup(fixture: Fixture = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = state()
  review.store!.total = fixture.reviewTotal ?? 0
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agent-tasks?')) return { items: fixture.tasks ?? [] }
    if (url.startsWith('/api/agent-attention?')) return { items: fixture.requests ?? [], total: fixture.requestTotal ?? (fixture.requests ?? []).length, counts: {} }
    if (url.startsWith('/api/project-agents/')) throw new ApiError('Not found', 404)
    if (url.startsWith('/api/workbenches?')) return { partial: false, workbenches: [] }
    if (url.startsWith('/api/preference-conflicts?')) return []
    if (url.startsWith('/api/notices?')) return { items: fixture.notices ?? [], total: (fixture.notices ?? []).length }
    if (url.startsWith('/api/statement?')) {
      if (fixture.statementRead) return fixture.statementRead()
      if (fixture.statement === undefined) throw new ApiError('Not found', 404)
      return fixture.statement
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: TodayPage },
    { path: '/workbench', component: WorkbenchPage },
    { path: '/workbench/:list', component: { template: '<div />' } },
    { path: '/inbox', component: { template: '<div />' } },
    { path: '/preferences', component: { template: '<div />' } },
  ] })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(TodayPage, { attachTo: document.body, global: { plugins: [pinia, router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router, pinia }
}
const sections = (wrapper: VueWrapper) => wrapper.findAll('[data-today-section]').map(item => item.attributes('data-today-section'))

beforeEach(() => { setLocale('zh-CN', { persist: false }); getJson.mockReset() })
afterEach(async () => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  forgetTeamWork()
  await vi.dynamicImportSettled()
})

describe('今天', () => {
  it('says one sentence and offers one start when nothing is there today', async () => {
    const { wrapper } = await setup()
    expect(sections(wrapper)).toEqual([])
    expect(wrapper.get('[data-today-empty]').text()).toContain('今天还没有事。对你的 AI 说一条习惯，它会记下来。')
    expect(wrapper.get('[data-today-try]').text()).toBe('说一条试试')
  })

  it('stacks the sections in their order and leaves out each one with nothing to show', async () => {
    const { wrapper } = await setup({ requests: [request('r1')], notices: [notice('n1', new Date())], tasks: [task('t1', 'running')], statement: statement() })
    expect(sections(wrapper)).toEqual(['decisions', 'done', 'statement', 'working'])
    expect(wrapper.find('[data-today-empty]').exists()).toBe(false)

    const without = await setup({ tasks: [task('t1', 'running')] })
    expect(sections(without.wrapper)).toEqual(['working'])
    expect(without.wrapper.get('[data-today-action="working"]').attributes('href')).toBe('/workbench')
  })

  it('shows five things at most: requests first, then the habits to confirm, then how many more wait', async () => {
    const few = await setup({ requests: [request('r1'), request('r2')], reviewTotal: 3 })
    expect(few.wrapper.findAll('[data-today-decision]').map(row => row.attributes('data-today-decision'))).toEqual(['request', 'request', 'review'])
    expect(few.wrapper.get('[data-today-decision="review"]').text()).toContain('还有 3 条习惯等你确认')
    expect(few.wrapper.find('[data-today-more]').exists()).toBe(false)
    expect(few.wrapper.get('[data-today-action="decisions"]').attributes('href')).toBe('/inbox')

    const many = await setup({ requests: ['r1', 'r2', 'r3', 'r4', 'r5'].map(request), requestTotal: 7, reviewTotal: 3 })
    expect(many.wrapper.findAll('[data-today-decision]')).toHaveLength(5)
    expect(many.wrapper.find('[data-today-decision="review"]').exists()).toBe(false)
    expect(many.wrapper.get('[data-today-more]').text()).toBe('还有 5 件')
  })

  it('lists only what happened on the local today, with the way to earlier ones', async () => {
    const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const { wrapper } = await setup({ notices: [notice('today', new Date()), notice('old', earlier)] })
    expect(wrapper.findAll('[data-notice]')).toHaveLength(1)
    expect(wrapper.get('[data-today-action="done"]').attributes('href')).toBe('/workbench/notices')

    const none = await setup({ notices: [notice('old', earlier)] })
    expect(sections(none.wrapper)).toEqual([])
  })

  it('shows the statement headline and its non-zero tiles, and leaves it out on 404 or when everything is zero', async () => {
    const { wrapper } = await setup({ statement: statement({ used: { times: 0, tasks: 0, cited: 0, applied: 0 } }) })
    expect(wrapper.get('[data-statement-total]').text()).toBe('你一共攒下 42 条习惯和经验')
    expect(wrapper.findAll('[data-statement-tile]').map(tile => tile.attributes('data-statement-tile'))).toEqual(['carried', 'learned', 'decided'])
    expect(wrapper.get('[data-statement-tile="carried"]').text()).toContain('跨 3 个客户端')
    // 0 taken back: no sub-line.
    expect(wrapper.get('[data-statement-tile="decided"]').text()).not.toContain('撤回')
    expect(wrapper.get('[data-statement-spark]').attributes('aria-label')).toBe('最近 2 周从 30 条到 42 条')

    const missing = await setup()
    expect(sections(missing.wrapper)).toEqual([])
    const zero = await setup({ statement: statement({ total: { confirmed: 0 }, carried: null, used: null, learned: null, decided: { forYou: 0, undone: 0 } }) })
    expect(sections(zero.wrapper)).toEqual([])
  })

  it('opens every number of the statement with what it counts and who saw it', async () => {
    const { wrapper } = await setup({ statement: statement() })
    await wrapper.get('[data-today-action="statement"]').trigger('click')
    const rows = wrapper.findAll('[data-statement-detail]')
    expect(rows.map(row => row.attributes('data-statement-detail'))).toContain('doneFailed')
    expect(wrapper.get('[data-statement-detail="usedTimes"]').text()).toContain('助手自己报告的')
    expect(wrapper.get('[data-statement-detail="carriedTasks"]').text()).toContain('FULI 亲眼看到的')
  })

  it('never puts a late section above one already shown', async () => {
    let answer: (value: unknown) => void = () => {}
    const { wrapper } = await setup({
      requests: [request('r1')], tasks: [task('t1', 'running')],
      statementRead: () => new Promise(resolve => { answer = resolve }),
    })
    // The statement is still being read: what is below it waits, so it can only append.
    expect(sections(wrapper)).toEqual(['decisions'])
    expect(wrapper.text()).toContain('正在读取这周的复利账单')
    answer(statement())
    await flushPromises()
    expect(sections(wrapper)).toEqual(['decisions', 'statement', 'working'])
  })
})

describe('工作台 at /workbench', () => {
  it('keeps the old home page there, beside its list pages', () => {
    expect(appRouter.resolve('/').name).toBe('today')
    expect(appRouter.resolve('/workbench').name).toBe('overview')
    expect(appRouter.resolve('/workbench/running').name).toBe('workbench-list')
    expect(appRouter.resolve('/workbench/notices').name).toBe('workbench-list')
  })

  it('renders the workbench stage and feed', async () => {
    const { router, pinia } = await setup()
    await router.push('/workbench')
    const wrapper = mount(WorkbenchPage, { global: { plugins: [pinia, router] } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-workbench-stage]').exists()).toBe(true)
    expect(wrapper.find('[data-workbench-feed]').exists()).toBe(true)
  })
})

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import TodayStatement from '@/features/today/TodayStatement.vue'
import { setLocale } from '@/i18n'
import { statementWeekOf } from './calendar'
import StatementCalendarPage from './StatementCalendarPage.vue'

// Synthetic counts only. "Now" is Friday 2026-11-13, local time.
const NOW = new Date(2026, 10, 13, 10, 0)
const statement = (captured: number) => ({
  window: { from: 'x', to: 'y' }, total: { confirmed: 42 }, series: [],
  carried: { tasks: 12, clients: 3, items: 40 }, used: { times: 7, tasks: 5, cited: 4, applied: 3 },
  learned: { captured, confirmedByYou: 4, confirmedByTonborg: 2, promotedByUse: 0, retired: 1 },
  decided: { forYou: 2, undone: 0 }, changed: { forYou: 1 }, done: { finished: 3, failed: 1 }, answered: { questions: 2 }, unavailable: [],
})
const DAYS = {
  days: [
    { day: '2026-11-02', learned: 1, confirmed: 0, used: 0, carried: 2 },
    { day: '2026-11-04', learned: 2, confirmed: 1, used: 3, carried: 0 },
    { day: '2026-11-12', learned: 40, confirmed: 0, used: 0, carried: 5 },
  ],
  unavailable: [] as string[],
}

interface Fixture { days?: unknown; week?: (from: string) => Promise<unknown> }
const mounted: VueWrapper[] = []
async function setup(fixture: Fixture = {}, path = '/statement') {
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/statement/days?')) return fixture.days ?? DAYS
    if (url.startsWith('/api/statement?')) {
      const from = new URLSearchParams(url.split('?')[1]).get('from')!
      return fixture.week ? fixture.week(from) : statement(Date.parse(from) === Date.parse(statementWeekOf('2026-11-09').from) ? 6 : 9)
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/statement', component: StatementCalendarPage },
  ] })
  await router.push(path)
  await router.isReady()
  const wrapper = mount({ template: '<RouterView />' }, { attachTo: document.body, global: { plugins: [router] } })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}
const weekRead = () => getJson.mock.calls.map(([url]) => String(url)).filter(url => url.startsWith('/api/statement?'))
const captured = (wrapper: VueWrapper) => wrapper.get('[data-statement-detail="learnedCaptured"]').text()
async function settle(router: Router) { await router.isReady(); await flushPromises() }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
})
afterEach(() => {
  mounted.splice(0).forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
})

describe('复利账单, day by day', () => {
  it('draws 53 weeks of days up to today, darker for more, and reads this week below by default', async () => {
    const { wrapper } = await setup()
    const range = new URLSearchParams(String(getJson.mock.calls.find(([url]) => String(url).startsWith('/api/statement/days?'))![0]).split('?')[1])
    expect(range.get('from')).toMatch(/^2025-11-10T00:00:00[+-]\d{2}:\d{2}$/)
    expect(range.get('to')).toMatch(/^2026-11-16T00:00:00[+-]\d{2}:\d{2}$/)
    const cells = wrapper.findAll('[data-day]')
    expect(cells).toHaveLength(52 * 7 + 5)
    expect(wrapper.find('[data-day="2026-11-13"]').exists()).toBe(true)
    expect(wrapper.find('[data-day="2026-11-14"]').exists()).toBe(false)
    // Seven weekday rows, Monday first, each naming its weekday.
    const rows = wrapper.findAll('[role="row"]')
    expect(rows).toHaveLength(7)
    expect(rows[0].get('[role="rowheader"]').attributes('aria-label')).toBe('星期一')
    expect(rows[0].findAll('[data-day]').at(-1)!.attributes('data-day')).toBe('2026-11-09')
    expect(wrapper.get('[data-day="2026-11-12"]').attributes()).toMatchObject({ 'data-level': '4', 'aria-label': '11月12日：新学到 40 条', title: '11月12日：新学到 40 条' })
    expect(wrapper.get('[data-day="2026-11-02"]').attributes('data-level')).toBe('1')
    expect(wrapper.get('[data-day="2026-11-03"]').attributes('data-level')).toBe('0')
    // One tab stop: today.
    expect(wrapper.findAll('[data-day][tabindex="0"]').map(cell => cell.attributes('data-day'))).toEqual(['2026-11-13'])
    expect(wrapper.findAll('[data-calendar-month]').map(month => month.text())).toContain('12月')
    expect(wrapper.get('[data-statement-week-range]').text()).toBe('11月9日 到 11月15日')
    expect(captured(wrapper)).toContain('6')
    expect(weekRead()).toEqual([expect.stringContaining(`from=${encodeURIComponent(statementWeekOf('2026-11-09').from)}`)])
  })

  it('switches the measure in place and keeps it in the URL', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-calendar-measure] [data-value="carried"]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.query.measure).toBe('carried')
    expect(wrapper.get('[data-day="2026-11-12"]').attributes('aria-label')).toBe('11月12日：5 次对话带上了习惯')
    expect(wrapper.get('[data-day="2026-11-04"]').attributes('data-level')).toBe('0')
    expect(wrapper.get('[data-day="2026-11-02"]').attributes('data-level')).not.toBe('0')
  })

  it('leaves out a measure the server could not read', async () => {
    const { wrapper } = await setup({ days: { days: [{ day: '2026-11-12', carried: 2 }], unavailable: ['learned', 'confirmed', 'used'] } })
    // One measure left: no switch to make.
    expect(wrapper.find('[data-calendar-measure]').exists()).toBe(false)
    expect(wrapper.get('[data-day="2026-11-12"]').attributes('aria-label')).toBe('11月12日：2 次对话带上了习惯')
  })

  it('a click on a day puts its week in the URL and shows that week; Back brings the last one back', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-day="2026-11-04"]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.query.week).toBe('2026-11-02')
    expect(wrapper.get('[data-statement-week-range]').text()).toBe('11月2日 到 11月8日')
    expect(wrapper.get('[data-statement-day]').text()).toBe('11月4日：新学到 2 条 · 确认了 1 条 · 被用上 3 次')
    expect(captured(wrapper)).toContain('9')
    expect(wrapper.get('[data-day="2026-11-04"]').attributes('aria-selected')).toBe('true')

    router.back()
    await settle(router)
    await vi.waitFor(() => expect(router.currentRoute.value.query.week).toBeUndefined())
    await flushPromises()
    expect(wrapper.get('[data-statement-week-range]').text()).toBe('11月9日 到 11月15日')
    expect(captured(wrapper)).toContain('6')
  })

  it('opens the week a link names, and moves a week with the arrows beside it', async () => {
    const { wrapper, router } = await setup({}, '/statement?week=2026-11-02')
    expect(wrapper.get('[data-statement-week-range]').text()).toBe('11月2日 到 11月8日')
    expect(wrapper.get('[data-statement-week-next]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-statement-week-next]').trigger('click')
    await settle(router)
    expect(router.currentRoute.value.query.week).toBe('2026-11-09')
    expect(wrapper.get('[data-statement-week-next]').attributes('disabled')).toBeDefined()
    // A week that is not a Monday of the calendar falls back to this week.
    const odd = await setup({}, '/statement?week=2026-11-03')
    expect(odd.wrapper.get('[data-statement-week-range]').text()).toBe('11月9日 到 11月15日')
  })

  it('keeps the last week on screen, dimmed, while another is read, with the reading mark in its own place', async () => {
    let release: (value: unknown) => void = () => {}
    let reads = 0
    const { wrapper, router } = await setup({ week: async () => (reads++ === 0 ? statement(6) : new Promise(resolve => { release = resolve })) })
    const place = wrapper.get('[data-statement-week-reading]')
    expect(place.find('.growth-loading').exists()).toBe(false)
    await wrapper.get('[data-day="2026-11-04"]').trigger('click')
    await settle(router)
    expect(captured(wrapper)).toContain('6')
    expect(wrapper.get('[data-statement-week-rows]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-statement-week]').attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[data-statement-week-reading] .growth-loading').attributes('aria-label')).toBe('正在读取 11月2日 到 11月8日 的复利账单')
    release(statement(9))
    await flushPromises()
    expect(captured(wrapper)).toContain('9')
    expect(wrapper.get('[data-statement-week-rows]').attributes('aria-busy')).toBe('false')
    expect(place.find('.growth-loading').exists()).toBe(false)
  })

  it('moves between days with the arrow keys and picks one with Enter', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-day="2026-11-13"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.findAll('[data-day][tabindex="0"]').map(cell => cell.attributes('data-day'))).toEqual(['2026-11-06'])
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-06')
    await wrapper.get('[data-day="2026-11-06"]').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-07')
    // Nothing after today.
    await wrapper.get('[data-day="2026-11-07"]').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-day')).toBe('2026-11-07')
    await wrapper.get('[data-day="2026-11-07"]').trigger('keydown', { key: 'Enter' })
    await settle(router)
    expect(router.currentRoute.value.query.week).toBe('2026-11-02')
  })

  it('says one sentence and draws no calendar when no day has anything', async () => {
    const { wrapper } = await setup({ days: { days: [], unavailable: [] } })
    expect(wrapper.get('[data-calendar-empty]').text()).toBe('还没有哪一天记下过东西。对你的 AI 说一条习惯，这里就会亮起来。')
    expect(wrapper.find('[data-day]').exists()).toBe(false)
    expect(wrapper.find('[data-statement-week]').exists()).toBe(false)
  })
})

describe('今天\'s statement card', () => {
  it('has one quiet link to every day, next to 查看详情', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/statement', component: { template: '<div />' } }] })
    await router.push('/')
    const wrapper = mount(TodayStatement, { props: { statement: statement(6), total: 42, tiles: [] }, global: { plugins: [router] } })
    mounted.push(wrapper)
    const link = wrapper.get('[data-today-action="statement-all"]')
    expect(link.attributes('href')).toBe('/statement')
    expect(link.text()).toBe('全部')
    expect(link.attributes('aria-label')).toBe('全部，按天看复利账单')
    expect(wrapper.find('[data-today-action="statement"]').text()).toBe('查看详情')
  })
})

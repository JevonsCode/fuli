import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import FlaActivity from './FlaActivity.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

// Synthetic days and tasks only. The section reads only once it comes into
// view, so the test drives a stand-in IntersectionObserver by hand.
let observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
class FakeObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(callback) }
  observe() {}
  disconnect() {}
}
const settle = () => new Promise(resolve => setTimeout(resolve, 350))
const comeIntoView = async () => { observers.forEach(callback => callback([{ isIntersecting: true }])); await settle(); await flushPromises() }
const passThrough = async () => {
  observers.forEach(callback => callback([{ isIntersecting: true }]))
  observers.forEach(callback => callback([{ isIntersecting: false }]))
  await settle(); await flushPromises()
}
const activityReads = () => getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/project-agent-activity?'))

const answer = (days: unknown[]) => ({ agentId: 'fla-1', personalSpaceId: 'space-a', fromDate: '2026-11-16', toDate: '2026-11-22', days })
const day = (date: string, total: number, tasks: unknown[] = []) => ({ date, completed: total, failed: 0, cancelled: 0, total, tasks })

const mounted: Array<{ unmount: () => void }> = []
async function render(agentId = 'fla-1') {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  const wrapper = mount(FlaActivity, { global: { plugins: [router] },
    props: { spaceId: 'space-a', agentId, agentName: 'Lumen', projectName: (id: string) => ({ ledger: 'Ledger import' })[id] ?? id } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

beforeEach(() => { observers = []; getJson.mockReset(); vi.stubGlobal('IntersectionObserver', FakeObserver) })
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals() })

describe('最近的活动', () => {
  it('does not read until the section comes into view, then reads the past year once', async () => {
    getJson.mockResolvedValue(answer([day('2026-11-20', 2)]))
    const wrapper = await render()
    expect(activityReads()).toHaveLength(0)
    expect(wrapper.find('[data-widget="fla-activity"]').exists()).toBe(true)

    // Flashing through the view while the sections above still load is not reading it.
    await passThrough()
    expect(activityReads()).toHaveLength(0)

    await comeIntoView()
    expect(activityReads()).toHaveLength(1)
    const url = new URL(String(activityReads()[0]![0]), 'http://local.test')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ personalSpaceId: 'space-a', agentId: 'fla-1' })
    expect(url.searchParams.get('fromDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    await comeIntoView()
    expect(activityReads()).toHaveLength(1)
  })

  it('shades each day and opens the tasks a day holds', async () => {
    getJson.mockResolvedValue(answer([day('2026-11-20', 2, [
      { taskId: 'task-1', title: 'Amount parser', status: 'completed', summary: 'Parsed the synthetic amounts', occurredAt: '2026-11-20T03:00:00Z', personalProjectId: 'ledger' },
    ]), day('2026-11-21', 1)]))
    const wrapper = await render()
    await comeIntoView()

    expect(wrapper.get('h2').text()).toContain('最近的活动')
    expect(wrapper.get('[data-activity-total]').text()).toBe('过去一年 3 件')
    const cells = wrapper.findAll('[data-activity-day]')
    expect(cells).toHaveLength(7)
    expect(cells.every(cell => cell.element.tagName === 'BUTTON')).toBe(true)
    const busy = cells.find(cell => cell.attributes('aria-label')?.includes('11月20日'))!
    expect(busy.classes()).toContain('intensity-4')
    await busy.trigger('click')
    expect(busy.attributes('aria-pressed')).toBe('true')
    const detail = wrapper.get('[data-activity-detail]').text()
    expect(detail).toContain('Amount parser')
    expect(detail).toContain('Ledger import')
    expect(detail).toContain('Parsed the synthetic amounts')
  })

  it('says a year with nothing recorded, without drawing empty squares', async () => {
    getJson.mockResolvedValue(answer([day('2026-11-20', 0)]))
    const wrapper = await render()
    await comeIntoView()
    expect(wrapper.get('[data-activity-empty]').text()).toBe('过去一年没有记下做完、没做成或取消的任务。')
    expect(wrapper.find('[data-activity-calendar]').exists()).toBe(false)
    expect(wrapper.find('[data-activity-total]').exists()).toBe(false)
  })

  it('says a failed read, never an empty year, and reads again on request', async () => {
    getJson.mockRejectedValueOnce(new Error('activity unavailable'))
    const wrapper = await render()
    await comeIntoView()
    expect(wrapper.get('[data-activity-failed]').text()).toContain('这次没读到它的活动记录')
    expect(wrapper.find('[data-activity-empty]').exists()).toBe(false)

    getJson.mockResolvedValue(answer([day('2026-11-20', 1)]))
    await wrapper.get('[data-activity-failed] button').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-activity-day]')).toHaveLength(7)
  })

  it('refuses an answer without its days as a failed read', async () => {
    getJson.mockImplementation(async (url: string, shape: { schema: { parse: (value: unknown) => unknown } }) => shape.schema.parse({ agentId: 'fla-1' }))
    const wrapper = await render()
    await comeIntoView()
    expect(wrapper.find('[data-activity-failed]').exists()).toBe(true)
  })

  it('a built-in role has no such record: no section and no read', async () => {
    const wrapper = await render('employee.jefa')
    await comeIntoView()
    expect(wrapper.find('[data-widget="fla-activity"]').exists()).toBe(false)
    expect(activityReads()).toHaveLength(0)
  })
})

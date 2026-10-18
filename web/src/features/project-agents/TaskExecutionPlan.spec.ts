import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLocale } from '@/i18n'
import { getJson } from '@/api/client'
import type { ProjectAgentTaskRecord } from '@/types'
import TaskExecutionPlan from './TaskExecutionPlan.vue'

vi.mock('@/api/client', () => ({ getJson: vi.fn() }))
const { celebrateOnce } = vi.hoisted(() => ({ celebrateOnce: vi.fn() }))
vi.mock('@/lib/celebration', () => ({ celebrateOnce }))
class NotificationSource extends EventTarget {
  static instances: NotificationSource[] = []
  closed = false
  constructor(public url: string) { super(); NotificationSource.instances.push(this) }
  close() { this.closed = true }
  ready() { this.dispatchEvent(new MessageEvent('ready', { data: '{}' })) }
  change(taskId: string | null = 'task-a') { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ taskId }) })) }
}
function source() { return NotificationSource.instances.at(-1)! }
beforeEach(() => { vi.stubGlobal('EventSource', NotificationSource); vi.mocked(getJson).mockResolvedValue(task()) })
const wrappers: ReturnType<typeof mount>[] = []
const task = (status = 'pending', detail?: string): ProjectAgentTaskRecord => ({
  taskId: 'task-a', personalSpaceId: 'space-a', personalProjectId: 'project-a', title: 'Synthetic task',
  status: 'running', participants: [], events: [{ eventId: `plan-${status}`, taskId: 'task-a',
    status: 'running', summary: 'Synthetic plan', createdAt: '2026-10-13T01:00:00Z',
    executionPlan: { steps: [{ id: 'verify', title: '验证结果', status: status as 'pending', detail }] } }],
})
function render(value = task()) {
  const wrapper = mount(TaskExecutionPlan, { props: { task: value, personalSpaceId: 'space-a', active: true } })
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  NotificationSource.instances = []; vi.unstubAllGlobals();
  vi.useRealTimers(); vi.resetAllMocks(); setLocale('zh-CN', { persist: false })
  vi.restoreAllMocks()
})

it('has no fabricated framework when the Agent did not report one', () => {
  expect(render({ ...task(), events: [] }).find('[data-execution-plan]').exists()).toBe(false)
})

it('shows explicit steps and refreshes their state without accepting the task', async () => {
  vi.useFakeTimers()
  vi.mocked(getJson).mockResolvedValue(task('completed', '测试通过'))
  const wrapper = render()
  expect(wrapper.text()).toContain('待开始')
  source().change(); await flushPromises()
  expect(wrapper.text()).toContain('已完成')
  expect(wrapper.text()).toContain('测试通过')
  expect(wrapper.text()).toContain('Agent 上报')
  expect(wrapper.text()).not.toContain('100%')
  expect(getJson).toHaveBeenCalledWith(expect.stringContaining('/api/project-agent-tasks/task-a?'), expect.objectContaining({ signal: expect.any(AbortSignal) }))
})

it('preserves the latest reported plan across unrelated events and respects explicit withdrawal', async () => {
  const value = task('in_progress')
  value.events!.push({ eventId: 'later', taskId: 'task-a', status: 'running', summary: 'Other progress', createdAt: '2026-10-13T02:00:00Z' })
  const wrapper = render(value)
  expect(wrapper.text()).toContain('进行中')
  await wrapper.setProps({ task: { ...value, events: [...value.events!, { ...value.events![1], eventId: 'withdraw',
    createdAt: '2026-10-13T03:00:00Z', executionPlan: { steps: [] } }] } })
  expect(wrapper.find('[data-execution-plan]').exists()).toBe(false)
})

it('retains visible progress when refresh fails and avoids requests from an inactive panel', async () => {
  vi.useFakeTimers()
  vi.mocked(getJson).mockRejectedValue(new Error('Synthetic outage'))
  const wrapper = render()
  source().change(); await flushPromises()
  expect(wrapper.text()).toContain('验证结果')
  expect(wrapper.text()).toContain('更新暂不可用')
  await wrapper.setProps({ active: false })
  expect(source().closed).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(getJson).toHaveBeenCalledTimes(1)
})

it('ignores a late response after switching to another task', async () => {
  vi.useFakeTimers()
  let resolve!: (value: unknown) => void
  vi.mocked(getJson).mockImplementation(() => new Promise(done => { resolve = done }))
  const wrapper = render()
  source().change()
  await wrapper.setProps({ task: { ...task(), taskId: 'task-b', events: [] } })
  resolve(task('completed')); await flushPromises()
  expect(wrapper.find('[data-execution-plan]').exists()).toBe(false)
})

it('discovers a newly reported plan and stops fetching after the task ends or the view unmounts', async () => {
  vi.useFakeTimers()
  vi.mocked(getJson).mockResolvedValue({ ...task('completed'), status: 'completed' })
  const wrapper = render({ ...task(), events: [] })
  source().change(); await flushPromises()
  expect(wrapper.text()).toContain('已完成')
  expect(source().closed).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(getJson).toHaveBeenCalledTimes(1)
  await wrapper.setProps({ task: task() })
  wrapper.unmount(); wrappers.pop()
  expect(source().closed).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(getJson).toHaveBeenCalledTimes(1)
})

it('suspends refresh while the browser page is hidden', async () => {
  vi.useFakeTimers()
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  vi.mocked(getJson).mockResolvedValue(task('in_progress'))
  const wrapper = render()
  expect(NotificationSource.instances).toHaveLength(0)
  expect(getJson).not.toHaveBeenCalled()
  hidden.mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange')); await flushPromises()
  source().change(); await flushPromises()
  expect(wrapper.text()).toContain('进行中')
})


it('does not poll idle tasks and syncs on connection or reconnection', async () => {
  vi.useFakeTimers()
  const wrapper = render()
  await vi.advanceTimersByTimeAsync(60000)
  expect(getJson).not.toHaveBeenCalled()
  source().ready(); await flushPromises()
  expect(getJson).toHaveBeenCalledTimes(1)
  source().dispatchEvent(new Event('error')); await flushPromises()
  expect(wrapper.text()).toContain('更新暂不可用')
  vi.mocked(getJson).mockResolvedValue(task('in_progress'))
  source().ready(); await flushPromises()
  expect(getJson).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain('进行中')
  expect(wrapper.text()).not.toContain('更新暂不可用')
})

it('shares one space connection and refreshes only the notified task', async () => {
  const a = render()
  const b = render({ ...task(), taskId: 'task-b' })
  expect(NotificationSource.instances).toHaveLength(1)
  expect(source().url).toBe('/api/project-agent-task-events?personalSpaceId=space-a')
  source().change('task-b'); await flushPromises()
  expect(getJson).toHaveBeenCalledTimes(1)
  expect(vi.mocked(getJson).mock.calls[0]![0]).toContain('/task-b?')
  a.unmount(); wrappers.shift()
  expect(source().closed).toBe(false)
  b.unmount(); wrappers.pop()
  expect(source().closed).toBe(true)
})

it('does not lose notifications arriving while a read is in flight', async () => {
  let resolve!: (value: unknown) => void
  vi.mocked(getJson).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    .mockResolvedValueOnce(task('completed'))
  const wrapper = render()
  source().change(); source().change()
  expect(getJson).toHaveBeenCalledTimes(1)
  resolve(task('in_progress')); await flushPromises()
  expect(getJson).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain('已完成')
})

it('resyncs all visible tasks after a coalesced burst', async () => {
  render(); render({ ...task(), taskId: 'task-b' })
  source().change(null); await flushPromises()
  expect(getJson).toHaveBeenCalledTimes(2)
})

it('celebrates a completion it saw happen, once, and never one already done on load', async () => {
  vi.mocked(getJson).mockResolvedValue({ ...task('completed'), status: 'completed', leadAgentId: 'agent-a' })
  const wrapper = render({ ...task(), leadAgentId: 'agent-a' })
  source().change(); await flushPromises()
  expect(celebrateOnce).toHaveBeenCalledTimes(1)
  expect(celebrateOnce).toHaveBeenCalledWith('task-completed:task-a', wrapper.get('[data-execution-plan]').element, expect.stringMatching(/^--identity-[0-7]$/))

  celebrateOnce.mockClear()
  render({ ...task('completed'), status: 'completed' })
  await flushPromises()
  expect(celebrateOnce).not.toHaveBeenCalled()
})

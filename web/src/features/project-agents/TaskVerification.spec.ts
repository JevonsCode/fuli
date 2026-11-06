import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskVerification from './TaskVerification.vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson }))

const render = (active: boolean) => mount(TaskVerification, { props: { personalSpaceId: 'space-a', personalProjectId: 'app', taskId: 'task-1', active } })

beforeEach(() => getJson.mockReset())

describe('task acceptance state', () => {
  it('reads once the details open and names what the state rests on', async () => {
    getJson.mockResolvedValue({ state: 'person_confirmed', evidence: [
      { state: 'person_confirmed', source: 'person', ref: 'e1' },
      { state: 'auto_verified', source: 'verification', ref: 'a1', refs: ['ci://synthetic/1'] }] })
    const wrapper = render(false)
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(getJson.mock.calls[0]![0]).toBe('/api/project-agent-tasks/task-1/verification?personalSpaceId=space-a&personalProjectId=app')
    expect(wrapper.get('[data-task-verification]').text()).toBe('验收人确认你确认过 · 测试证据 1 条')
  })

  it('says 尚未验证 without evidence, and nothing when the server cannot say', async () => {
    getJson.mockResolvedValueOnce({ state: 'unverified', evidence: [] })
    const plain = render(true)
    await flushPromises()
    expect(plain.get('[data-task-verification]').text()).toBe('验收尚未验证')
    getJson.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))
    const old = render(true)
    await flushPromises()
    expect(old.find('[data-task-verification]').exists()).toBe(false)
  })
})

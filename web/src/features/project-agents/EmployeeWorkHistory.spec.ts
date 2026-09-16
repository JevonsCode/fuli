import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))
import EmployeeWorkHistory from './EmployeeWorkHistory.vue'

beforeEach(() => getJson.mockReset())
const record = (summary: string) => ({ taskContextToken: 'synthetic-task', status: 'incomplete',
  sourceApplication: 'cursor', createdAt: '2026-09-16T00:00:00Z', summary })
function mountHistory() {
  return mount(EmployeeWorkHistory, { props: { personalSpaceId: 'space', agentId: 'agent',
    projects: [{ id: 'project-a', name: 'Project A' }, { id: 'project-b', name: 'Project B' }] } })
}
async function open(wrapper: ReturnType<typeof mountHistory>) {
  wrapper.get('details').element.open = true
  await wrapper.get('details').trigger('toggle')
  await flushPromises()
}

it('loads work records only when opened and preserves truthful incomplete status', async () => {
  getJson.mockResolvedValue({ workLog: [record('Verification interrupted; resume the remaining checks.')] })
  const wrapper = mountHistory()
  await flushPromises()
  expect(getJson).not.toHaveBeenCalled()
  await open(wrapper)
  expect(getJson).toHaveBeenCalledWith('/api/project-agents/agent/memory?personalSpaceId=space&personalProjectId=project-a')
  expect(wrapper.text()).toContain('Verification interrupted')
  expect(wrapper.text()).toContain('cursor')
})

it('ignores an older project response after the project selector changes', async () => {
  let finish!: (value: unknown) => void
  getJson.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const wrapper = mountHistory()
  await open(wrapper)
  getJson.mockResolvedValue({ workLog: [record('Current project record')] })
  await wrapper.get('select').setValue('project-b')
  await flushPromises()
  finish({ workLog: [record('Old project record')] })
  await flushPromises()
  expect(wrapper.text()).toContain('Current project record')
  expect(wrapper.text()).not.toContain('Old project record')
})

it('offers retry on read failure and reloads the same employee scope', async () => {
  getJson.mockRejectedValueOnce(new Error('Synthetic network failure'))
  const wrapper = mountHistory()
  await open(wrapper)
  expect(wrapper.get('[role="alert"]').text()).toContain('Synthetic network failure')
  getJson.mockResolvedValue({ workLog: [record('Recovered summary')] })
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('Recovered summary')
})

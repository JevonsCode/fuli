import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EmployeeTaskDialog from './EmployeeTaskDialog.vue'
const { postJson } = vi.hoisted(() => ({ postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ postJson }))
const item = { id: 'task-a', projectId: 'project-a', title: 'Original task', status: 'planned' as const, updatedAt: '2026-09-01T00:00:00.000Z' }
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))
beforeEach(() => { postJson.mockReset(); postJson.mockResolvedValue({ item: { ...item, title: 'Fresh task', updatedAt: '2026-09-02T00:00:00.000Z' } }) })
async function setup(existing = true) {
  const wrapper = mount(EmployeeTaskDialog, { props: { open: true, item: existing ? item : null, canWrite: true, projects: [{ id: 'project-a', name: 'Alpha' }], personalSpaceId: 'space-a', defaultProjectId: 'project-a' } })
  wrappers.push(wrapper); await flushPromises(); return wrapper
}
describe('native task dialog', () => {
  it('reads the exact task and saves with the fresh optimistic-lock version', async () => {
    const wrapper = await setup()
    expect(postJson).toHaveBeenCalledWith('/api/employee-templates/jefa/call', { personalSpaceId: 'space-a', personalProjectId: 'project-a', tool: 'get_task', arguments: { workItemId: 'task-a' } })
    await wrapper.get('input[minlength="2"]').setValue('Updated task')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(postJson.mock.lastCall?.[1]).toMatchObject({ tool: 'update_tasks', arguments: { updates: [{ id: 'task-a', title: 'Updated task', expectedUpdatedAt: '2026-09-02T00:00:00.000Z' }] } })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })
  it('creates a task only after an explicit project and title are provided', async () => {
    const wrapper = await setup(false)
    expect(postJson).not.toHaveBeenCalled()
    await wrapper.get('input[minlength="2"]').setValue('New task')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(postJson.mock.lastCall?.[1]).toMatchObject({ personalProjectId: 'project-a', tool: 'create_tasks', arguments: { tasks: [{ title: 'New task' }] } })
  })
  it('shows failures without reporting success or changing the board', async () => {
    const wrapper = await setup()
    postJson.mockRejectedValue(new Error('revision conflict'))
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('revision conflict')
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
})

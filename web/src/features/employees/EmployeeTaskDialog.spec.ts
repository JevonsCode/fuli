import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EmployeeTaskDialog from './EmployeeTaskDialog.vue'
const { postJson } = vi.hoisted(() => ({ postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), postJson }))
import { ApiError } from '@/api/client'
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
  it('says a task does not exist only when its own read answers 404; a gate or other failure keeps its reason', async () => {
    postJson.mockRejectedValue(new ApiError('{"error":"no such work item"}', 404, '{"error":"no such work item"}'))
    expect((await setup()).get('[role="alert"]').text()).toContain('任务不存在。')
    postJson.mockRejectedValue(new ApiError('gone', 404, '{"error":"Project is unavailable","code":"project_not_found"}'))
    expect((await setup()).get('[role="alert"]').text()).not.toContain('任务不存在')
    postJson.mockRejectedValue(new ApiError('denied', 403, '{"error":"Employee tool is not available or permitted","code":"tool_not_permitted"}'))
    expect((await setup()).get('[role="alert"]').text()).not.toContain('任务不存在')
  })
  it('shows failures without reporting success or changing the board', async () => {
    const wrapper = await setup()
    postJson.mockRejectedValue(new Error('revision conflict'))
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('revision conflict')
    expect(wrapper.emitted('saved')).toBeUndefined()
  })
  for (const outcome of ['resolve', 'reject'] as const) {
    it(`keeps a late save of one task (${outcome}) from closing or writing into the next task opened`, async () => {
      let finishSave!: { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
      postJson.mockImplementation((_url: string, body: { tool: string; arguments: { workItemId?: string } }) => {
        if (body.tool === 'update_tasks') return new Promise((resolve, reject) => { finishSave = { resolve, reject } })
        const id = body.arguments.workItemId
        return Promise.resolve({ item: { ...item, id, title: `Task ${id}`, summary: `Body ${id}`, updatedAt: '2026-09-02T00:00:00.000Z' } })
      })
      const wrapper = await setup()
      await wrapper.get('form').trigger('submit'); await flushPromises()
      // Browser Back closes the quick look while the save runs; then another task opens.
      await wrapper.setProps({ open: false, item: null }); await flushPromises()
      await wrapper.setProps({ open: true, item: { id: 'task-b', projectId: 'project-a' } }); await flushPromises()
      expect((wrapper.get('input[minlength="2"]').element as HTMLInputElement).value).toBe('Task task-b')
      if (outcome === 'resolve') finishSave.resolve({}); else finishSave.reject(new Error('A failed late'))
      await flushPromises()
      expect(wrapper.emitted('close')).toBeUndefined()
      // A late success still refreshes the board: the change was made.
      if (outcome === 'resolve') expect(wrapper.emitted('saved')).toHaveLength(1)
      else expect(wrapper.emitted('saved')).toBeUndefined()
      expect(wrapper.text()).not.toContain('A failed late')
      expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    })
  }
})

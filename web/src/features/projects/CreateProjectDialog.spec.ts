import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { putJson, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message) }
  }
  return { putJson: vi.fn(), ApiError }
})
vi.mock('@/api/client', () => ({ putJson, ApiError }))
import CreateProjectDialog from './CreateProjectDialog.vue'

const render = () => mount(CreateProjectDialog, {
  attachTo: document.body,
  props: { open: true, personalSpaceId: 'space-a', existingProjectIds: ['fuli-console'] },
})

describe('CreateProjectDialog', () => {
  beforeEach(() => putJson.mockReset())

  it('needs only a name and shows the ID it will create', async () => {
    const wrapper = render()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(putJson).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('请填写项目名称')

    const name = document.querySelector('input[name="new-project-name"]') as HTMLInputElement
    name.value = 'Fuli Console'; name.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    expect(document.querySelector('[data-new-project-id]')!.textContent).toContain('fuli-console-2')
    putJson.mockResolvedValue({ project_id: 'fuli-console-2' })
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(putJson.mock.calls[0]![1]).toMatchObject({ projectId: 'fuli-console-2', createOnly: true })
    expect(wrapper.emitted('created')).toEqual([[{ project_id: 'fuli-console-2' }]])
    wrapper.unmount()
  })

  it('explains a taken ID instead of overwriting the existing project', async () => {
    putJson.mockRejectedValueOnce(new ApiError('personal project already exists', 409))
    const wrapper = render()
    const name = document.querySelector('input[name="new-project-name"]') as HTMLInputElement
    name.value = 'Raced'; name.dispatchEvent(new Event('input', { bubbles: true })); await flushPromises()
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(document.body.textContent).toContain('这个项目标识已被占用')
    expect(wrapper.emitted('created')).toBeUndefined()
    wrapper.unmount()
  })
})

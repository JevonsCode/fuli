import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import EmployeeShareDialog from './EmployeeShareDialog.vue'
import { reportProjects, reportUrl } from './shared-report'
const { getJson, patchJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, patchJson }))
const projects = [{ id: 'project-a', name: 'Alpha' }, { id: 'project-b', name: 'Beta' }]
const wrappers: ReturnType<typeof mount>[] = []
beforeEach(() => {
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    const id = url.includes('/project-a/') ? 'project-a' : 'project-b'
    if (url.includes('/api/public/')) return { project: { id, name: id }, items: [{ id: `task-${id}`, title: 'Public task', status: 'active' }] }
    return { snapshot: { projects: [{ id, publicShareEnabled: false }] } }
  })
  patchJson.mockImplementation(async (url: string, body: { publicShareEnabled: boolean }) => ({ project: { id: url.includes('/project-a/') ? 'project-a' : 'project-b', ...body, publicShareSlug: body.publicShareEnabled ? 'share-00000000-0000-0000-0000-000000000001' : undefined } }))
  patchJson.mockClear()
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })
async function setup() { const wrapper = mount(EmployeeShareDialog, { props: { open: true, projects } }); wrappers.push(wrapper); await flushPromises(); return wrapper }
describe('share scope', () => {
  it('previews zero public tasks without publishing private tasks or creating an empty link', async () => {
    getJson.mockImplementation(async (url: string) => {
      const id = url.includes('/project-a/') ? 'project-a' : 'project-b'
      if (url.includes('/api/public/')) return { project: { id, name: id }, items: [] }
      return { snapshot: { projects: [{ id, publicShareEnabled: true, publicShareSlug: 'share-00000000-0000-0000-0000-000000000001' }], workItems: [{ id: 'private-task', title: 'PRIVATE', privacy: 'personal' }] } }
    })
    const wrapper = await setup()
    await wrapper.get('.project-scope-all input').setValue(true)
    expect(wrapper.get('.employee-share-preview').text()).toContain('0 条公开任务')
    expect(wrapper.get('.employee-share-empty').text()).toContain('不会改变任务的隐私设置')
    expect(wrapper.get('footer .primary').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).not.toContain('PRIVATE')
    expect(patchJson).not.toHaveBeenCalled()
    const before = getJson.mock.calls.length
    await wrapper.setProps({ projects: projects.map(project => ({ ...project, name: `${project.name}!` })) })
    expect(wrapper.get('.project-scope-all input').element).toHaveProperty('checked', true)
    expect(getJson.mock.calls).toHaveLength(before)
  })

  it('verifies newly enabled projections and reports zero content without a misleading link', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => url.includes('/api/public/')
      ? { project: { id: url.includes('/project-a/') ? 'project-a' : 'project-b', name: 'Synthetic' }, items: [] } : original(url))
    const wrapper = await setup()
    await wrapper.get('.project-scope-all input').setValue(true)
    await wrapper.get('footer .primary').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toContain('暂无可公开任务')
    expect(wrapper.find('[aria-label="分享链接"]').exists()).toBe(false)
    expect(patchJson.mock.calls.every(([url]) => String(url).endsWith('/sharing'))).toBe(true)
  })

  it('keeps revocation available when the public preview fails', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('/api/public/')) throw new Error('temporarily unavailable')
      return { snapshot: { projects: [{ id: url.includes('/project-a/') ? 'project-a' : 'project-b', publicShareEnabled: true, publicShareSlug: 'share-00000000-0000-0000-0000-000000000001' }] } }
    })
    const wrapper = await setup()
    expect(wrapper.get('[role="alert"]').text()).toContain('读取失败')
    expect(wrapper.findAll('.employee-share-active button')).toHaveLength(2)
    expect(patchJson).not.toHaveBeenCalled()
  })

  it('does not enable sharing on opening; all projects produce one report link', async () => {
    const wrapper = await setup()
    expect(patchJson).not.toHaveBeenCalled()
    expect(wrapper.get('footer .primary').attributes('disabled')).toBeDefined()
    await wrapper.get('.project-scope-all input').setValue(true)
    await wrapper.get('footer .primary').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledTimes(2)
    const link = (wrapper.get('[aria-label="分享链接"]').element as HTMLInputElement).value
    expect(reportProjects(new URL(link).hash).map(project => project.id)).toEqual(['project-a', 'project-b'])
    expect(new URL(link).search).toBe('')
  })
  it('shows the generation phase in the share button until the delayed request completes', async () => {
    const wrapper = await setup()
    await wrapper.get('input[value="project-a"]').setValue(true)
    let resolvePatch!: (value: unknown) => void
    patchJson.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve }))

    const pendingClick = wrapper.get('footer .primary').trigger('click')
    await nextTick()
    expect(wrapper.find('footer .primary .growth-loading--inline').exists()).toBe(true)
    expect(wrapper.get('footer .primary .growth-loading__label').text()).toBe('正在生成分享链接…')

    resolvePatch({ project: { id: 'project-a', publicShareEnabled: true, publicShareSlug: 'share-00000000-0000-0000-0000-000000000001' } })
    await pendingClick
    await flushPromises()
    expect(wrapper.get('footer .primary').text()).toContain('生成分享链接')
    expect(wrapper.find('footer .primary .growth-loading--inline').exists()).toBe(false)
    expect(wrapper.find('[aria-label="分享链接"]').exists()).toBe(true)
  })
  it('shows the revoke phase only on the project being revoked', async () => {
    getJson.mockImplementation(async (url: string) => {
      const id = url.includes('/project-a/') ? 'project-a' : 'project-b'
      if (url.includes('/api/public/')) return { project: { id, name: id }, items: [{ id: `task-${id}`, title: 'Public task', status: 'active' }] }
      return { snapshot: { projects: [{ id, publicShareEnabled: true, publicShareSlug: 'share-00000000-0000-0000-0000-000000000001' }] } }
    })
    const wrapper = await setup()
    const revokeButtons = wrapper.findAll('.employee-share-active button')
    expect(revokeButtons).toHaveLength(2)
    let resolveRevoke!: (value: unknown) => void
    patchJson.mockImplementationOnce(() => new Promise((resolve) => { resolveRevoke = resolve }))

    const pendingClick = revokeButtons[0]!.trigger('click')
    await nextTick()
    expect(revokeButtons[0]!.find('.growth-loading--inline').exists()).toBe(true)
    expect(revokeButtons[0]!.get('.growth-loading__label').text()).toBe('正在关闭分享…')
    expect(wrapper.findAll('.growth-loading--inline')).toHaveLength(1)
    expect(wrapper.get('footer .primary').text()).toContain('生成分享链接')
    expect(wrapper.find('footer .primary .growth-loading--inline').exists()).toBe(false)

    resolveRevoke({ project: { id: 'project-a', publicShareEnabled: false } })
    await pendingClick
    await flushPromises()
    expect(wrapper.get('.employee-share-active').text()).toContain('Beta')
    expect(wrapper.get('.employee-share-active').text()).not.toContain('Alpha')
  })
  it('supports project inversion without enabling excluded projects', async () => {
    const wrapper = await setup()
    await wrapper.get('input[value="project-a"]').setValue(true)
    await wrapper.get('.project-scope-bulk button').trigger('click')
    await wrapper.get('footer .primary').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenCalledExactlyOnceWith('/employee-workspaces/jefa/project-b/api/projects/project-b/sharing', { publicShareEnabled: true, acceptsPublicRequests: false })
    expect(reportProjects(new URL((wrapper.get('[aria-label="分享链接"]').element as HTMLInputElement).value).hash)).toHaveLength(1)
    await wrapper.get('input[value="project-a"]').setValue(true)
    expect(wrapper.find('[aria-label="分享链接"]').exists()).toBe(false)
  })
  it('does not claim a complete link when only some writes succeed and supports revocation', async () => {
    patchJson.mockImplementation(async (url: string, body: { publicShareEnabled: boolean }) => {
      if (url.includes('/project-b/')) throw new Error('unavailable')
      return { project: { id: 'project-a', ...body, publicShareSlug: body.publicShareEnabled ? 'share-00000000-0000-0000-0000-000000000001' : undefined } }
    })
    const wrapper = await setup()
    await wrapper.get('.project-scope-all input').setValue(true)
    await wrapper.get('footer .primary').trigger('click'); await flushPromises()
    expect(wrapper.find('[aria-label="分享链接"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toContain('部分项目')
    expect(wrapper.get('.employee-share-active').text()).toContain('Alpha')
    await wrapper.get('.employee-share-active button').trigger('click'); await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith('/employee-workspaces/jefa/project-a/api/projects/project-a/sharing', { publicShareEnabled: false, acceptsPublicRequests: false })
  })
  it('validates report capabilities and never places them in query strings', () => {
    const url = new URL(reportUrl([{ id: 'project-a', slug: 'share-00000000-0000-0000-0000-000000000001' }], 'https://example.test'))
    expect(url.pathname).toBe('/reports/jefa'); expect(url.search).toBe('')
    expect(reportProjects(url.hash)[0]?.id).toBe('project-a')
    expect(() => reportProjects('#p=not-json')).toThrow()
    expect(() => reportProjects('#p=%5B%22a%22%2C%22javascript%3Afoo%22%5D')).toThrow()
    expect(() => reportProjects(url.hash + '&' + url.hash.slice(1))).toThrow()
  })
})

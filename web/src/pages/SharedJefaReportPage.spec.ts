import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import SharedJefaReportPage from './SharedJefaReportPage.vue'
import { reportUrl } from '@/features/employees/shared-report'
const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))
const wrappers: ReturnType<typeof mount>[] = []
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); getJson.mockReset() })
describe('public report', () => {
  it.each(['Example project', 'R&D + 50% #团队'])('decodes %s exactly once with the real router', async (id) => {
    getJson.mockResolvedValue({ project: { id, name: 'Synthetic project' }, items: [{ id: 'task-a', title: 'Visible report', status: 'active' }] })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports/jefa', component: SharedJefaReportPage }] })
    const url = new URL(reportUrl([{ id, slug: 'share-00000000-0000-0000-0000-000000000001' }], 'https://example.test'))
    await router.push(url.pathname + url.hash)
    const wrapper = mount(SharedJefaReportPage, { global: { plugins: [router] } }); wrappers.push(wrapper)
    await flushPromises()
    expect(getJson).toHaveBeenCalledExactlyOnceWith(`/employee-workspaces/jefa/${encodeURIComponent(id)}/api/public/share-00000000-0000-0000-0000-000000000001`)
    expect(wrapper.text()).toContain('Visible report')
  })

  it('distinguishes a valid empty report from failed projects without loading private data', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('/project-b/')) throw new Error('revoked')
      return { project: { id: 'project-a', name: 'Alpha' }, items: [] }
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports/jefa', component: SharedJefaReportPage }] })
    const url = new URL(reportUrl(['project-a', 'project-b'].map(id => ({ id, slug: 'share-00000000-0000-0000-0000-000000000001' })), 'https://example.test'))
    await router.push(url.pathname + url.hash)
    const wrapper = mount(SharedJefaReportPage, { global: { plugins: [router] } }); wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.get('.report-state').text()).toContain('暂无可公开的任务')
    expect(wrapper.get('.report-state').text()).toContain('已读取 1 个项目')
    expect(wrapper.get('.report-warning').text()).toContain('1 个项目')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(getJson.mock.calls.every(([url]) => String(url).includes('/api/public/'))).toBe(true)
  })

  it('loads only selected public projections and strips private fields', async () => {
    getJson.mockResolvedValue({ project: { id: 'project-a', name: 'Alpha' }, items: [{ id: 'task-a', title: 'Public name', status: 'active', summary: 'PRIVATE SUMMARY', tags: ['PRIVATE TAG'], priority: 'high' }] })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/reports/jefa', component: SharedJefaReportPage }] })
    const url = new URL(reportUrl([{ id: 'project-a', slug: 'share-00000000-0000-0000-0000-000000000001' }], 'https://example.test'))
    await router.push(url.pathname + url.hash)
    const wrapper = mount(SharedJefaReportPage, { global: { plugins: [router] } }); wrappers.push(wrapper); await flushPromises()
    expect(getJson).toHaveBeenCalledExactlyOnceWith('/employee-workspaces/jefa/project-a/api/public/share-00000000-0000-0000-0000-000000000001')
    expect(wrapper.text()).toContain('Public name')
    expect(wrapper.text()).not.toContain('PRIVATE')
    expect(wrapper.find('.employee-all-projects-drag-handle').exists()).toBe(false)
    expect(wrapper.find('.employee-board-create').exists()).toBe(false)
    expect(wrapper.get('.employee-all-projects-task-open').attributes('disabled')).toBeDefined()
  })
})

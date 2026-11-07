import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DreamingCard from './DreamingCard.vue'
import { readDreaming, startDreaming, type DreamingProject } from './dreaming'

vi.mock('./dreaming', () => ({ readDreaming: vi.fn(), startDreaming: vi.fn() }))

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
const project = (id: string, extra: Partial<DreamingProject> = {}): DreamingProject => ({ personalProjectId: id, name: `Synthetic ${id}`,
  readiness: 'ready', newSessions: 0, lastRun: { at: ago(72), status: 'dreamed', sessions: 2, proposed: 0 }, ...extra })
const mountCard = (props = {}) => mount(DreamingCard, { props, global: { stubs: { RouterLink: RouterLinkStub } } })
const row = (wrapper: ReturnType<typeof mountCard>, id: string) => wrapper.get(`[data-dreaming-row="${id}"]`)

describe('DreamingCard', () => {
  beforeEach(() => { vi.mocked(readDreaming).mockReset(); vi.mocked(startDreaming).mockReset() })

  it('says a model is needed and offers no run without one', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'needs_model', projects: [] })
    const wrapper = mountCard()
    await flushPromises()
    // Astro has no model: the model line says so once, and the action opens Astro's settings.
    expect(wrapper.get('[data-model-use-model]').text()).toBe('Astro 还没接模型')
    expect(wrapper.get('[data-dreaming-needs-model]').isVisible()).toBe(false)
    expect(wrapper.find('[data-dreaming-run]').exists()).toBe(false)
    await wrapper.get('[data-dreaming-open]').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
    // Astro has a model but Dreaming is off: the note says where to turn it on.
    await wrapper.setProps({ model: 'synthetic-chat', status: 'disabled' })
    expect(wrapper.get('[data-dreaming-needs-model]').text()).toContain('打开 Dreaming')
    expect(wrapper.get('[data-model-use-state]').text()).toBe('未打开')
  })

  it('puts projects with new sessions first and folds the rest into a short quiet list', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [
      project('q1'), project('fresh', { newSessions: 4 }), project('q2'), project('q3'), project('q4'),
      project('empty', { lastRun: null }), project('unapproved', { readiness: 'project_not_approved', newSessions: null, lastRun: null })] })
    const wrapper = mountCard({ model: 'synthetic-chat', status: 'enabled' })
    await flushPromises()
    expect(wrapper.get('[data-dreaming-daily]').text()).toContain('有新会话的授权项目')
    const freshList = wrapper.get('[data-dreaming-list="fresh"]')
    expect(freshList.findAll('[data-dreaming-row]').map(item => item.attributes('data-dreaming-row'))).toEqual(['fresh'])
    expect(row(wrapper, 'fresh').get('[data-dreaming-meta]').text()).toBe('4 个新会话 · 上次整理 3天前')
    expect(row(wrapper, 'fresh').get('[data-dreaming-run]').text()).toBe('整理')

    const quietIds = () => wrapper.get('[data-dreaming-list="quiet"]').findAll('[data-dreaming-row]').map(item => item.attributes('data-dreaming-row'))
    expect(quietIds()).toEqual(['q1', 'q2', 'q3'])
    expect(row(wrapper, 'q1').get('[data-dreaming-meta]').text()).toBe('没有新会话 · 上次整理 3天前')
    expect(row(wrapper, 'q1').get('[data-dreaming-run]').text()).toBe('整理一次')
    await wrapper.get('[data-dreaming-more]').trigger('click')
    expect(quietIds()).toEqual(['q1', 'q2', 'q3', 'q4', 'empty'])
    // Never run and nothing to read: nothing to press.
    expect(row(wrapper, 'empty').text()).toContain('还没有会话')
    expect(row(wrapper, 'empty').find('[data-dreaming-run]').exists()).toBe(false)

    expect(wrapper.find('[data-dreaming-row="unapproved"]').exists()).toBe(false)
    expect(wrapper.get('[data-dreaming-unapproved]').text()).toBe('1 个项目还没授权，内容不会发给 Astro 的模型。')
    await wrapper.get('[data-dreaming-open]').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })

  it('runs a project in place, says what it found and links to the review queue', async () => {
    vi.mocked(readDreaming).mockResolvedValueOnce({ readiness: 'ready', projects: [project('alpha', { newSessions: 4 }), project('beta')] })
      .mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 0, lastRun: { at: ago(0), status: 'dreamed', sessions: 4, proposed: 1 } }),
        project('beta')] })
    let finish: (value: Awaited<ReturnType<typeof startDreaming>>) => void = () => {}
    vi.mocked(startDreaming).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const wrapper = mountCard({ model: 'synthetic-chat', status: 'enabled' })
    await flushPromises()
    await row(wrapper, 'alpha').get('[data-dreaming-run]').trigger('click')
    expect(startDreaming).toHaveBeenCalledWith('alpha', false)
    // One run at a time; the other project's button waits.
    expect(row(wrapper, 'beta').get('[data-dreaming-run]').attributes('disabled')).toBeDefined()
    finish({ status: 'dreamed', sessions: 4, proposed: [{ action: 'add', seenIn: 3, status: 'queued' }, { action: 'add', seenIn: 3, status: 'failed' }] })
    await flushPromises()
    // Its count is 0 now, but it stays where it was pressed.
    expect(wrapper.get('[data-dreaming-list="fresh"]').find('[data-dreaming-row="alpha"]').exists()).toBe(true)
    expect(row(wrapper, 'alpha').get('[data-dreaming-meta]').text()).toBe('看了 4 个会话，提了 1 条建议')
    expect(row(wrapper, 'alpha').getComponent(RouterLinkStub).props('to')).toBe('/inbox')
  })

  it('reads every session again from the quiet list, and a run with nothing new offers no link', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [project('beta')] })
    vi.mocked(startDreaming).mockResolvedValue({ status: 'dreamed', sessions: 6, proposed: [] })
    const wrapper = mountCard({ model: 'synthetic-chat', status: 'enabled' })
    await flushPromises()
    await row(wrapper, 'beta').get('[data-dreaming-run]').trigger('click')
    await flushPromises()
    expect(startDreaming).toHaveBeenCalledWith('beta', true)
    expect(row(wrapper, 'beta').get('[data-dreaming-meta]').text()).toBe('看了 6 个会话，提了 0 条建议')
    expect(row(wrapper, 'beta').find('[data-dreaming-confirm]').exists()).toBe(false)
  })

  it('shows a failed run as an error line and keeps the list', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 1 })] })
    vi.mocked(startDreaming).mockRejectedValue(new Error('synthetic failure'))
    const wrapper = mountCard({ model: 'synthetic-chat', status: 'enabled' })
    await flushPromises()
    await row(wrapper, 'alpha').get('[data-dreaming-run]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBeTruthy()
    expect(row(wrapper, 'alpha').get('[data-dreaming-meta]').text()).toBe('1 个新会话 · 上次整理 3天前')
  })

  it('says when the state cannot be read', async () => {
    vi.mocked(readDreaming).mockRejectedValue(new Error('synthetic failure'))
    const wrapper = mountCard({ model: 'synthetic-chat', status: 'enabled' })
    await flushPromises()
    expect(wrapper.text()).toContain('暂时读不到 Dreaming 的状态。')
    expect(wrapper.find('[data-dreaming-run]').exists()).toBe(false)
  })
})

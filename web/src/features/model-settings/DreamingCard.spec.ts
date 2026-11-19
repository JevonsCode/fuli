import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DreamingCard from './DreamingCard.vue'
import { readDreaming, startDreaming, type DreamingProject } from './dreaming'
import { checkModelRole } from './model'

vi.mock('./dreaming', async importOriginal => ({ ...await importOriginal<typeof import('./dreaming')>(), readDreaming: vi.fn(), startDreaming: vi.fn() }))
vi.mock('./model', async importOriginal => ({ ...await importOriginal<typeof import('./model')>(), checkModelRole: vi.fn() }))

const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()
const project = (id: string, extra: Partial<DreamingProject> = {}): DreamingProject => ({ personalProjectId: id, name: `Synthetic ${id}`,
  readiness: 'ready', newSessions: 0, lastRun: { at: ago(72), status: 'dreamed', sessions: 2, proposed: 0 }, ...extra })
type Run = Awaited<ReturnType<typeof startDreaming>>

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })
const mountCard = async (props = {}) => {
  const wrapper = mount(DreamingCard, { props: { model: 'synthetic-chat', status: 'enabled' as const, ...props }, attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const card = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-dreaming]')
const openDetails = async (wrapper: ReturnType<typeof mount>) => {
  await wrapper.get('[data-dreaming-details]').trigger('click')
  return wrapper.get('[data-dreaming-dialog]')
}
const row = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.get(`[data-dreaming-row="${id}"]`)

describe('DreamingCard', () => {
  beforeEach(() => { vi.mocked(readDreaming).mockReset(); vi.mocked(startDreaming).mockReset(); vi.mocked(checkModelRole).mockReset() })

  it('says a model is needed and offers no run without one', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'needs_model', projects: [] })
    const wrapper = await mountCard({ model: null, status: 'not_configured' })
    // Astro has no model: the model line says so once, and the action opens Astro's settings.
    expect(wrapper.get('[data-model-use-model]').text()).toBe('Astro 还没接独立模型，这项不运行')
    expect(wrapper.get('[data-dreaming-needs-model]').isVisible()).toBe(false)
    expect(wrapper.find('[data-dreaming-run-all]').exists()).toBe(false)
    expect(wrapper.find('[data-dreaming-details]').exists()).toBe(false)
    await wrapper.get('[data-dreaming-open]').trigger('click')
    expect(wrapper.emitted('edit')).toHaveLength(1)
    // Astro has a model but Dreaming is off: the note says where to turn it on.
    await wrapper.setProps({ model: 'synthetic-chat', status: 'disabled' })
    expect(wrapper.get('[data-dreaming-needs-model]').text()).toContain('打开 Dreaming')
    expect(wrapper.get('[data-model-use-state]').text()).toBe('未打开')
  })

  it('stays one line however many projects there are: the count with new sessions, the last run, and 整理全部', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [
      ...Array.from({ length: 13 }, (_, index) => project(`fresh-${index}`, { newSessions: index + 1, lastRun: { at: ago(index + 2), status: 'dreamed', sessions: 1, proposed: 0 } })),
      project('q1'), project('q2'), project('empty', { lastRun: null }),
      project('unapproved', { readiness: 'project_not_approved', newSessions: null, lastRun: null })] })
    const wrapper = await mountCard()
    expect(card(wrapper).get('[data-dreaming-summary]').text()).toBe('13 个项目共 91 个新会话等整理，提出的建议进待确认等你拍板 · 上次整理 2小时前')
    // No project is listed on the card.
    expect(card(wrapper).find('[data-dreaming-row]').exists()).toBe(false)
    expect(card(wrapper).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '整理全部'])

    // Every project is in the details: new sessions first, the rest quiet, in full.
    const dialog = await openDetails(wrapper)
    expect(dialog.get('[data-dreaming-list="fresh"]').findAll('[data-dreaming-row]')).toHaveLength(13)
    expect(row(wrapper, 'fresh-3').get('[data-dreaming-meta]').text()).toBe('4 个新会话 · 上次整理 5小时前')
    expect(row(wrapper, 'fresh-3').get('[data-dreaming-run]').text()).toBe('整理')
    expect(dialog.get('[data-dreaming-list="quiet"]').findAll('[data-dreaming-row]').map(item => item.attributes('data-dreaming-row'))).toEqual(['q1', 'q2', 'empty'])
    expect(row(wrapper, 'q1').get('[data-dreaming-meta]').text()).toBe('没有新会话 · 上次整理 3天前')
    expect(row(wrapper, 'q1').get('[data-dreaming-run]').text()).toBe('整理一次')
    // Never run and nothing to read: nothing to press.
    expect(row(wrapper, 'empty').text()).toContain('还没有会话')
    expect(row(wrapper, 'empty').find('[data-dreaming-run]').exists()).toBe(false)
    expect(wrapper.find('[data-dreaming-row="unapproved"]').exists()).toBe(false)
    expect(dialog.get('[data-dreaming-unapproved]').text()).toBe('1 个项目还没授权，内容不会发给 Astro 的模型。')
    // Before any run here the steps only explain how a run works.
    expect(dialog.findAll('[data-use-step]').map(step => [step.attributes('data-use-step'), step.attributes('data-state')]))
      .toEqual([['read', 'idle'], ['pick', 'idle'], ['review', 'idle']])
    expect(dialog.get('[data-use-step="pick"]').text()).toContain('3 个会话')
    await dialog.get('[data-dreaming-authorize]').trigger('click')
    expect(wrapper.emitted('authorize')).toHaveLength(1)
    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(wrapper.find('[data-dreaming-dialog]').exists()).toBe(false)
  })

  it('with nothing new says so and has nothing to run', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [project('q1')] })
    const wrapper = await mountCard()
    expect(wrapper.get('[data-dreaming-summary]').text()).toBe('没有新会话 · 上次整理 3天前')
    expect(wrapper.get('[data-dreaming-run-all]').attributes('disabled')).toBeDefined()
  })

  it('整理全部 runs the projects with new sessions one after another, then says what it found with a link to the review queue', async () => {
    const after = (id: string) => project(id, { newSessions: 0, lastRun: { at: ago(0), status: 'dreamed', sessions: 4, proposed: 1 } })
    vi.mocked(readDreaming).mockResolvedValueOnce({ readiness: 'ready', projects: [project('alpha', { newSessions: 4 }), project('beta', { newSessions: 2 }), project('quiet')] })
      .mockResolvedValueOnce({ readiness: 'ready', projects: [after('alpha'), project('beta', { newSessions: 2 }), project('quiet')] })
      .mockResolvedValue({ readiness: 'ready', projects: [after('alpha'), after('beta'), project('quiet')] })
    const finish: ((value: Run) => void)[] = []
    vi.mocked(startDreaming).mockImplementation(() => new Promise((resolve) => { finish.push(resolve) }))
    const wrapper = await mountCard()
    await wrapper.get('[data-dreaming-run-all]').trigger('click')
    expect(vi.mocked(startDreaming).mock.calls).toEqual([['alpha', false]])
    // The button names the project it is on.
    expect(wrapper.get('[data-dreaming-run-all] [role="status"]').attributes('aria-label')).toBe('正在整理 Synthetic alpha 的会话')
    // The card says which project runs, its place in the queue and the sessions it reads.
    expect(card(wrapper).get('[data-dreaming-summary]').text()).toBe('第 1/2 个 · 正在整理 Synthetic alpha：读 4 个新会话，找值得记住的')
    expect(card(wrapper).get('[data-dreaming-summary]').attributes('role')).toBe('status')
    finish[0]!({ status: 'dreamed', sessions: 4, candidates: 3, unread: 1, usage: { totalTokens: 1200 },
      proposed: [{ action: 'add', seenIn: 3, status: 'queued' }, { action: 'add', seenIn: 3, status: 'failed' }] })
    await flushPromises()
    expect(vi.mocked(startDreaming).mock.calls).toEqual([['alpha', false], ['beta', false]])
    expect(wrapper.get('[data-dreaming-run-all] [role="status"]').attributes('aria-label')).toBe('正在整理 Synthetic beta 的会话')
    expect(card(wrapper).get('[data-dreaming-summary]').text()).toBe('第 2/2 个 · 正在整理 Synthetic beta：读 2 个新会话，找值得记住的')
    finish[1]!({ status: 'dreamed', sessions: 2, candidates: 0, usage: { totalTokens: 400 }, proposed: [] })
    await flushPromises()
    // What the runs reported, added up: sessions, leads, what reached the queue and what did not.
    expect(wrapper.get('[data-dreaming-summary]').text())
      .toBe('读了 6 个会话，找到 3 条线索，1 条进了待确认 · 1 个会话没读成 · 1 条没放进待确认 · 用了 1600 tokens 去确认')
    expect(card(wrapper).getComponent(RouterLinkStub).props('to')).toBe('/inbox')
    // In the details a project that ran keeps its place and says what it found.
    const dialog = await openDetails(wrapper)
    expect(dialog.get('[data-dreaming-list="fresh"]').findAll('[data-dreaming-row]').map(item => item.attributes('data-dreaming-row'))).toEqual(['alpha', 'beta'])
    expect(row(wrapper, 'alpha').get('[data-dreaming-meta]').text()).toBe('读了 4 个会话，找到 3 条线索，1 条进了待确认 · 1 个会话没读成 · 1 条没放进待确认 · 用了 1200 tokens')
    expect(dialog.findAll('[data-use-step]').map(step => [step.attributes('data-state'), step.get('[data-use-step-detail]').text()])).toEqual([
      ['done', '读了 6 个会话，找到 3 条线索 · 1 个会话没读成'], ['done', '2 条够格'], ['active', '1 条在待确认等你']])
    expect(row(wrapper, 'alpha').find('[data-dreaming-confirm]').exists()).toBe(true)
    expect(row(wrapper, 'beta').find('[data-dreaming-confirm]').exists()).toBe(false)
  })

  it('reads every session again from the quiet list, one run at a time', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 1 }), project('beta')] })
    let finish: (value: Run) => void = () => {}
    vi.mocked(startDreaming).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const wrapper = await mountCard()
    await openDetails(wrapper)
    await row(wrapper, 'beta').get('[data-dreaming-run]').trigger('click')
    expect(startDreaming).toHaveBeenCalledWith('beta', true)
    expect(row(wrapper, 'alpha').get('[data-dreaming-run]').attributes('disabled')).toBeDefined()
    finish({ status: 'dreamed', sessions: 6, proposed: [] })
    await flushPromises()
    expect(row(wrapper, 'beta').get('[data-dreaming-meta]').text()).toBe('读了 6 个会话，找到 0 条线索，0 条进了待确认')
  })

  it('a run the model did not answer says why on the card, with 重试 for the project and 测试连接 for Astro', async () => {
    const waiting = { readiness: 'ready', projects: [project('alpha', { newSessions: 3 }), project('beta')] }
    vi.mocked(readDreaming).mockResolvedValueOnce(waiting).mockResolvedValueOnce(waiting)
      .mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { lastRun: { at: ago(0), status: 'dreamed', sessions: 3, proposed: 0 } }), project('beta')] })
    vi.mocked(startDreaming).mockResolvedValueOnce({ status: 'model_failed', sessions: 3, proposed: [], modelReceipt: { reason: 'auth_failed' } })
      .mockResolvedValue({ status: 'dreamed', sessions: 3, proposed: [] })
    vi.mocked(checkModelRole).mockResolvedValue({ ok: true, receipt: { status: 'completed', actualModel: 'synthetic-chat' } })
    const wrapper = await mountCard()
    await wrapper.get('[data-dreaming-run-all]').trigger('click')
    await flushPromises()
    const failure = card(wrapper).get('[data-dreaming-failed]')
    expect(failure.get('[data-model-failure-text]').text()).toBe('Synthetic alpha 没整理完：密钥不对')
    expect(failure.attributes('role')).toBe('alert')
    // The same place holds the action: 整理全部 became 重试.
    expect(card(wrapper).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '重试'])

    // 测试连接 tests Astro's model, answers in place, and asks the page to read the settings again.
    await failure.get('[data-model-check]').trigger('click')
    await flushPromises()
    expect(checkModelRole).toHaveBeenCalledWith('assistant')
    expect(failure.get('[data-model-failure-text]').text()).toBe('连接正常，synthetic-chat 回答了。')
    expect(wrapper.emitted('checked')).toHaveLength(1)

    // In the details the project's row says why and its button is 重试.
    await openDetails(wrapper)
    expect(row(wrapper, 'alpha').get('[data-dreaming-meta]').text()).toBe('没整理完：密钥不对')
    expect(row(wrapper, 'alpha').get('[data-dreaming-run]').text()).toBe('重试')
    await wrapper.get('[data-dreaming-dialog] button[aria-label="关闭"]').trigger('click')

    // 重试 runs the project that did not finish again.
    await wrapper.get('[data-dreaming-retry]').trigger('click')
    await flushPromises()
    expect(vi.mocked(startDreaming).mock.calls).toEqual([['alpha', false], ['alpha', false]])
    expect(wrapper.find('[data-dreaming-failed]').exists()).toBe(false)
    expect(wrapper.get('[data-dreaming-summary]').text()).toBe('读了 3 个会话，找到 0 条线索，0 条进了待确认')
  })

  it('shows a failure of the daily run and of the request itself, each with its reason', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [
      project('alpha', { newSessions: 2, lastRun: { at: ago(5), status: 'model_failed', sessions: 2, proposed: 0 } }),
      project('beta', { newSessions: 1, lastRun: { at: ago(5), status: 'superseded', sessions: 1, proposed: 0 } }), project('gamma', { newSessions: 1 })] })
    vi.mocked(startDreaming).mockRejectedValue(new Error('synthetic failure'))
    const wrapper = await mountCard()
    expect(wrapper.get('[data-model-failure-text]').text()).toBe('2 个项目没整理完：模型没回答')
    await openDetails(wrapper)
    expect(row(wrapper, 'beta').get('[data-dreaming-meta]').text()).toBe('没整理完：设置在整理时变了')
    await row(wrapper, 'gamma').get('[data-dreaming-run]').trigger('click')
    await flushPromises()
    expect(row(wrapper, 'gamma').get('[data-dreaming-meta]').text()).toBe('没整理完：synthetic failure')
    expect(row(wrapper, 'gamma').get('[data-dreaming-run]').text()).toBe('重试')
  })

  it('while a run reads, the details mark the first step with the project and its sessions', async () => {
    vi.mocked(readDreaming).mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 5 }),
      project('beta', { newSessions: 1, lastRun: { at: ago(5), status: 'model_failed', sessions: 1, proposed: 0 } })] })
    vi.mocked(startDreaming).mockReturnValue(new Promise(() => {}))
    const wrapper = await mountCard()
    const dialog = await openDetails(wrapper)
    await row(wrapper, 'alpha').get('[data-dreaming-run]').trigger('click')
    const read = dialog.get('[data-use-step="read"]')
    expect(read.attributes('data-state')).toBe('active')
    expect(read.attributes('aria-current')).toBe('step')
    expect(read.get('[data-use-step-detail]').text()).toBe('正在整理 Synthetic alpha：读 5 个新会话，找值得记住的')
    // One request does the reading: no bar, and no later step claims to have started.
    expect(read.find('[data-use-step-progress]').exists()).toBe(false)
    expect(dialog.get('[data-use-step="pick"]').attributes('data-state')).toBe('idle')
    // What did not finish before keeps its own line while another project runs.
    expect(dialog.get('[data-model-failure-text]').text()).toBe('Synthetic beta 没整理完：模型没回答')
  })

  it('with every project waiting for approval, 去授权 opens Astro settings and the card reads again when they close', async () => {
    const waiting = project('alpha', { readiness: 'project_not_approved', newSessions: null, lastRun: null })
    vi.mocked(readDreaming).mockResolvedValueOnce({ readiness: 'ready', projects: [waiting] })
      .mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 2, lastRun: null })] })
    const wrapper = await mountCard()
    expect(card(wrapper).get('[data-dreaming-summary]').text()).toBe('1 个项目还没授权，内容不会发给 Astro 的模型。')
    expect(card(wrapper).findAll('footer button').map(button => button.text())).toEqual(['查看详情', '去授权'])
    await wrapper.get('[data-dreaming-authorize]').trigger('click')
    expect(wrapper.emitted('authorize')).toHaveLength(1)
    // The page opens the settings; the person approves the project and closes them.
    await wrapper.setProps({ settingsOpen: true })
    await wrapper.setProps({ settingsOpen: false })
    await flushPromises()
    expect(readDreaming).toHaveBeenCalledTimes(2)
    expect(card(wrapper).get('[data-dreaming-summary]').text()).toContain('1 个项目共 2 个新会话等整理')
    // Left from the card, the person is back on the card.
    expect(wrapper.find('[data-dreaming-dialog]').exists()).toBe(false)
  })

  it('去授权 from the details comes back to the details with the approved project listed', async () => {
    vi.mocked(readDreaming).mockResolvedValueOnce({ readiness: 'ready', projects: [project('alpha', { newSessions: 1 }),
      project('beta', { readiness: 'project_not_approved', newSessions: null, lastRun: null })] })
      .mockResolvedValue({ readiness: 'ready', projects: [project('alpha', { newSessions: 1 }), project('beta', { newSessions: 3, lastRun: null })] })
    const wrapper = await mountCard()
    const dialog = await openDetails(wrapper)
    await dialog.get('[data-dreaming-authorize]').trigger('click')
    expect(wrapper.find('[data-dreaming-dialog]').exists()).toBe(false)
    await wrapper.setProps({ settingsOpen: true })
    await wrapper.setProps({ settingsOpen: false })
    // Back at once, before the read answers.
    expect(wrapper.find('[data-dreaming-dialog]').exists()).toBe(true)
    await flushPromises()
    expect(row(wrapper, 'beta').get('[data-dreaming-meta]').text()).toBe('3 个新会话 · 还没整理过')
    expect(wrapper.find('[data-dreaming-unapproved]').exists()).toBe(false)
  })

  it('says when the state cannot be read, and reads it again on 重试', async () => {
    vi.mocked(readDreaming).mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue({ readiness: 'ready', projects: [project('q1')] })
    const wrapper = await mountCard()
    expect(wrapper.get('[data-dreaming-unavailable]').text()).toBe('暂时读不到 Dreaming 的状态。')
    expect(wrapper.find('[data-dreaming-run-all]').exists()).toBe(false)
    await wrapper.get('[data-dreaming-reload]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-dreaming-summary]').text()).toBe('没有新会话 · 上次整理 3天前')
  })
})

import { DOMWrapper, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getJson }))

import { setLocale } from '@/i18n'
import ProjectChangeLog from './ProjectChangeLog.vue'
import type { ProjectChangeEntry } from './project-change-log'

const person = { kind: 'person', agentId: null, agentName: null } as const
const ada = { kind: 'agent', agentId: 'agent-ada', agentName: 'Ada' } as const
const fuli = { kind: 'fuli', agentId: null, agentName: null } as const

function entry(id: number, actor: ProjectChangeEntry['actor'], changes: ProjectChangeEntry['changes']): ProjectChangeEntry {
  return { id, at: '2026-11-01T08:30:00.000Z', actor, changes }
}

function mountLog(props: Record<string, unknown> = {}) {
  return mount(ProjectChangeLog, {
    attachTo: document.body,
    props: { spaceId: 'space-1', projectId: 'project a', projectName: 'Alpha', updatedAt: 'first', ...props },
    global: { stubs: { RouterLink: RouterLinkStub, MeLink: { template: '<a data-me-link>我</a>' } } },
  })
}

const dialog = () => new DOMWrapper(document.querySelector<HTMLElement>('[data-project-change-details]')!)

describe('ProjectChangeLog', () => {
  beforeEach(() => {
    setLocale('zh-CN')
    getJson.mockReset()
  })

  afterEach(() => { document.body.innerHTML = '' })

  it('reads on open and shows nothing at all for an empty history', async () => {
    getJson.mockResolvedValue({ entries: [], hasMore: false })
    const wrapper = mountLog()
    await flushPromises()
    expect(getJson.mock.calls[0][0]).toBe('/api/personal-projects/project%20a/history?personalSpaceId=space-1')
    expect(wrapper.find('[data-project-change-log]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('lists who changed which field and when, the latest five rows', async () => {
    const changes = [{ field: 'purpose', before: 'a', after: 'b' }, { field: 'name', before: 'c', after: 'd' }] as const
    getJson.mockResolvedValue({ hasMore: false, entries: [
      entry(7, person, [...changes]),
      entry(6, ada, [changes[0]]),
      entry(5, fuli, [changes[0]]),
      ...[4, 3, 2].map((id) => entry(id, person, [changes[0]])),
    ] })
    const wrapper = mountLog()
    await flushPromises()
    const rows = wrapper.findAll('[data-project-change]')
    expect(rows).toHaveLength(5)
    expect(rows[0].find('[data-me-link]').exists()).toBe(true)
    expect(rows[0].text()).toContain('改了 项目目标和项目名称')
    expect(rows[1].findComponent(RouterLinkStub).text()).toBe('Ada')
    expect(rows[2].text()).toContain('FULI 改了 项目目标')
    wrapper.unmount()
  })

  it('opens the full before and after text in 查看详情, naming nothing as 空 and lifecycles by label', async () => {
    getJson.mockResolvedValue({ hasMore: true, entries: [entry(2, ada, [
      { field: 'scope', before: '', after: 'First line\nSecond line' },
      { field: 'lifecycle', before: 'planned', after: 'archived' },
    ])] })
    const wrapper = mountLog()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Second line')
    await wrapper.get('[data-project-change-details-open]').trigger('click')
    await flushPromises()
    const scope = dialog().get('[data-changed-field="scope"]').findAll('dd').map((value) => value.text())
    expect(scope[0]).toBe('空')
    expect(scope[1]).toContain('Second line')
    const lifecycle = dialog().get('[data-changed-field="lifecycle"]').findAll('dd').map((value) => value.text())
    expect(lifecycle).toEqual(['计划中', '已归档'])
    expect(dialog().get('[data-project-change-more]').text()).toBe('只显示最近 1 条')
    wrapper.unmount()
  })

  it('never reads a failure as an empty history, and retries', async () => {
    getJson.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountLog()
    await flushPromises()
    const notice = wrapper.get('[data-project-change-log-failed]')
    expect(notice.text()).toContain('修改记录暂时读不到')
    getJson.mockResolvedValue({ hasMore: false, entries: [entry(1, person, [{ field: 'name', before: 'a', after: 'b' }])] })
    await notice.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-project-change-log-failed]').exists()).toBe(false)
    expect(wrapper.findAll('[data-project-change]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('reads again after a save and keeps what it showed when that read fails', async () => {
    getJson.mockResolvedValueOnce({ hasMore: false, entries: [entry(1, person, [{ field: 'name', before: 'a', after: 'b' }])] })
    const wrapper = mountLog()
    await flushPromises()
    getJson.mockRejectedValueOnce(new Error('offline'))
    await wrapper.setProps({ updatedAt: 'second' })
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('[data-project-change]')).toHaveLength(1)
    expect(wrapper.get('[data-project-change-log-failed]').text()).toContain('刷新失败')
    wrapper.unmount()
  })

  it('names the action while the first read is pending', async () => {
    vi.useFakeTimers()
    getJson.mockReturnValue(new Promise(() => {}))
    const wrapper = mountLog()
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在读取修改记录')
    wrapper.unmount()
    vi.useRealTimers()
  })
})

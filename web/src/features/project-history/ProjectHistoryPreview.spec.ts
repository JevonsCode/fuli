import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson }))

import ProjectHistoryPreview from './ProjectHistoryPreview.vue'
import { setLocale, t } from '@/i18n'

const CONVERSATION = `conversation-${'c'.repeat(64)}`
const projects = [
  { project_id: CONVERSATION, personal_space_id: 'space-1', profile: { name: '会话项目 / Conversation project' } },
  { project_id: 'broken', personal_space_id: 'space-1', profile: { name: '会话项目 / Conversation project' } },
]

function respond(url: string) {
  if (url.startsWith('/api/personal-projects?')) return projects
  if (url.startsWith('/api/project-agent-assignments?')) return []
  if (url.startsWith('/api/project-agent-tasks?')) return []
  if (url.includes('personalProjectId=broken')) return { nodes: [{ id: 'k1', name: 'k1', type: 'Fact' }], edges: [], truncated: true, next_offset: 0 }
  return { nodes: [], edges: [], truncated: false }
}

describe('ProjectHistoryPreview', () => {
  beforeEach(() => {
    setLocale('zh-CN', { persist: false })
    getJson.mockReset()
  })

  it('reads nothing until asked, then shows facts, incompleteness and preview-only suggestions', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/personal-projects?')) await gate
      return respond(url)
    })
    const wrapper = mount(ProjectHistoryPreview, { props: { spaceId: 'space-1' } })
    expect(getJson).not.toHaveBeenCalled()

    await wrapper.get('[data-generate]').trigger('click')
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe(t('projectHistory.loadingProjects'))
    release()
    await flushPromises()

    expect(wrapper.get(`[data-project="${CONVERSATION}"]`).attributes('data-suggestion')).toBe('archive_candidate')
    const broken = wrapper.get('[data-project="broken"]')
    // A partial page already proves history exists; it still counts as incomplete.
    expect(broken.attributes('data-suggestion')).toBe('keep')
    expect(broken.text()).toContain(t('projectHistory.status.incomplete', { count: 1 }))
    expect(broken.text()).toContain(t('projectHistory.reason.broken_cursor'))
    expect(broken.text()).toContain(t('projectHistory.origin.unknown'))
    expect(broken.text()).toContain(t('projectHistory.sameNameNote'))
    expect(wrapper.get('[data-completeness]').attributes('data-completeness')).toBe('incomplete')
    expect(wrapper.find('[data-memory-unknown]').exists()).toBe(true)
    // The only control is reading again; there is no archive, merge or delete action.
    expect(wrapper.findAll('button').map(button => button.text())).toEqual([t('projectHistory.regenerate')])
  })

  it('reports a failed project list instead of showing an empty preview', async () => {
    getJson.mockRejectedValue(new Error('offline'))
    const wrapper = mount(ProjectHistoryPreview, { props: { spaceId: 'space-1' } })
    await wrapper.get('[data-generate]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe(t('projectHistory.failed'))
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('names the project currently being read from real progress', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    getJson.mockImplementation(async (url: string) => {
      if (url.includes('personalProjectId=broken') && url.startsWith('/api/graph')) await gate
      return respond(url)
    })
    const wrapper = mount(ProjectHistoryPreview, { props: { spaceId: 'space-1' } })
    await wrapper.get('[data-generate]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').attributes('aria-label'))
      .toBe(t('projectHistory.loadingEvidence', { done: 2, total: 2 }))
    release()
    await flushPromises()
    expect(wrapper.find('table').exists()).toBe(true)
  })
})

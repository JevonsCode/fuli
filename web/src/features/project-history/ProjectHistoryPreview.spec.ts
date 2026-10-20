import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ getJson }))

import ProjectHistoryPreview from './ProjectHistoryPreview.vue'
import { setLocale, t } from '@/i18n'

const CONVERSATION = `conversation-${'c'.repeat(64)}`
const projects = [
  { project_id: CONVERSATION, personal_space_id: 'space-1', profile: { name: '会话项目 / Conversation project' } },
  { project_id: 'broken', personal_space_id: 'space-1', profile: { name: '会话项目 / Conversation project' } },
]

// The preview opens in a dialog (a portal), so it is read from the document.
const dialog = () => new DOMWrapper(document.querySelector<HTMLElement>('[data-project-history-dialog]')!)

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
  afterEach(() => { document.body.innerHTML = '' })

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
    expect(dialog().get('[role="status"]').attributes('aria-label')).toBe(t('projectHistory.loadingProjects'))
    release()
    await flushPromises()

    expect(dialog().get(`[data-project="${CONVERSATION}"]`).attributes('data-suggestion')).toBe('archive_candidate')
    const broken = dialog().get('[data-project="broken"]')
    // A partial page already proves history exists; it still counts as incomplete.
    expect(broken.attributes('data-suggestion')).toBe('keep')
    expect(broken.text()).toContain(t('projectHistory.status.incomplete', { count: 1 }))
    expect(broken.text()).toContain(t('projectHistory.reason.broken_cursor'))
    expect(broken.text()).toContain(t('projectHistory.origin.unknown'))
    expect(broken.text()).toContain(t('projectHistory.sameNameNote'))
    expect(dialog().get('[data-completeness]').attributes('data-completeness')).toBe('incomplete')
    expect(dialog().find('[data-memory-unknown]').exists()).toBe(true)
    // The only control is reading again; there is no archive, merge or delete action.
    expect(dialog().findAll('button:not([aria-label])').map(button => button.text())).toEqual([t('projectHistory.regenerate')])
    expect(wrapper.get('[data-generate]').text()).toBe(t('projectHistory.regenerate'))
  })

  it('reports a failed project list instead of showing an empty preview', async () => {
    getJson.mockRejectedValue(new Error('offline'))
    const wrapper = mount(ProjectHistoryPreview, { props: { spaceId: 'space-1' } })
    await wrapper.get('[data-generate]').trigger('click')
    await flushPromises()
    expect(dialog().get('[role="alert"]').text()).toBe(t('projectHistory.failed'))
    expect(dialog().find('table').exists()).toBe(false)
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
    expect(dialog().get('[role="status"]').attributes('aria-label'))
      .toBe(t('projectHistory.loadingEvidence', { done: 2, total: 2 }))
    release()
    await flushPromises()
    expect(dialog().find('table').exists()).toBe(true)
  })

  it('stops a read in progress when its dialog closes', async () => {
    getJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = mount(ProjectHistoryPreview, { props: { spaceId: 'space-1' }, attachTo: document.body })
    await wrapper.get('[data-generate]').trigger('click')
    await flushPromises()
    const { signal } = getJson.mock.calls[0]![1] as { signal: AbortSignal }
    expect(signal.aborted).toBe(false)
    dialog().element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(document.querySelector('[data-project-history-dialog]')).toBeNull()
    expect(wrapper.get('[data-generate]').text()).toBe(t('projectHistory.generate'))
    wrapper.unmount()
  })
})

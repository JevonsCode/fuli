import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()), getJson, postJson, patchJson,
}))

import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import KnowledgeItemEditPage from './KnowledgeItemEditPage.vue'

// rec#20: a receipt link opens this one item's quick edit.
function view(overrides = {}) {
  return { item_kind: 'entity', item_id: 'item-1', version: 4, title: 'Prefer short status lines',
    content: 'Prefer short status lines', type: 'PersonalPreference', profile_aspect: 'taste', category: 'taste',
    scope: { kind: 'temporary', projects: [{ id: 'temporary-x', name: '临时会话', temporary: true }], status: 'undetermined' },
    weight: { percent: 12, basis: { confirmation_status: 'pending', confirmed_by_person: false, qualified_use_count: 0,
      distinct_task_count: 0, source_count: 1, negative_evidence_count: 0 } },
    tags: [{ id: 't1', name: 'status', namespace: 'personal', status: 'active' }],
    confirmation_status: 'pending', content_source: 'user_explicit', invalid_at: null,
    evidence: [{ episode_id: 'e1', source_kind: 'task_remember', source_application: 'codex', session_id: 'session-123456789',
      excerpt: '以后状态写短一点', created_at: '2026-10-21T00:00:00Z' }], evidence_count: 1,
    revisions: [{ id: 'r1', action: 'scope_change', reason: 'Only here', created_at: '2026-10-21T01:00:00Z' }],
    ...overrides }
}

async function open(item = view()) {
  getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents') ? [] : item)
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [
      { project_id: 'alpha', personal_space_id: 'space', profile: { name: 'Alpha' } },
      { project_id: 'temporary-x', personal_space_id: 'space', scope_type: 'temporary', profile: { name: '临时会话' } },
    ], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: KnowledgeItemEditPage },
    { path: '/organize', component: { template: '<div />' } }, { path: '/preferences', component: { template: '<div />' } }] })
  await router.push('/knowledge/item/space/entity/item-1')
  await router.isReady()
  const wrapper = mount(KnowledgeItemEditPage, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  getJson.mockReset()
  postJson.mockReset()
  patchJson.mockReset()
})

describe('KnowledgeItemEditPage', () => {
  it('reads this one item and shows its stored state, with scope pending apart from content pending', async () => {
    const wrapper = await open()
    expect(getJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1?personalSpaceId=space')
    expect(wrapper.get('[data-item-content]').text()).toBe('Prefer short status lines')
    expect(wrapper.get('[data-item-category]').text()).toBe('品味')
    expect(wrapper.get('[data-item-source]').text()).toBe('你明确说的')
    expect(wrapper.get('[data-item-confirmation]').text()).toBe('待确认')
    expect(wrapper.get('[data-item-scope]').text()).toContain('临时会话项目')
    expect(wrapper.get('[data-scope-undetermined]').text()).toBe('范围待确定')
    expect(wrapper.get('[data-item-weight]').text()).toContain('依据：用过 0 次 · 0 个任务 · 1 个来源')
    expect(wrapper.get('[data-item-weight]').text()).toContain('不能手动改')
    expect(wrapper.get('[data-item-tags]').text()).toContain('#status')
    expect(wrapper.get('[data-item-sources]').text()).toContain('以后状态写短一点')
    expect(wrapper.get('[data-item-revisions]').text()).toContain('调整范围')
    wrapper.unmount()
  })

  it('rec#5 C6-3: a source names the session it came from and opens that session at the turn that wrote it', async () => {
    const wrapper = await open(view({ evidence: [
      { episode_id: 'e1', source_application: 'codex', session_id: 'session-123456789', excerpt: '以后状态写短一点' },
      { episode_id: 'e2', source_application: null, session_id: 'import-batch', excerpt: 'Imported' }] }))
    const links = wrapper.findAll('[data-source-session]')
    expect(links).toHaveLength(1)
    expect(links[0].text()).toBe('来自哪个会话')
    expect(links[0].attributes('href')).toBe('/s/session-123456789?client=codex&item=space/episode%3Ae1')
    wrapper.unmount()
  })

  it('says when an item has no weight instead of inventing one', async () => {
    const wrapper = await open(view({ weight: null }))
    expect(wrapper.get('[data-item-weight]').text()).toBe('暂无权重')
    expect(wrapper.get('[data-item-weight]').text()).not.toMatch(/%/)
    wrapper.unmount()
  })

  it('moves the same item with the version it shows, and reads it back after saving', async () => {
    const wrapper = await open()
    postJson.mockResolvedValue({ scope: { kind: 'global' } })
    await wrapper.get('[data-scope-choice="global"] [role="radio"]').trigger('click')
    await wrapper.get('#scope-reason').setValue('Applies everywhere')
    await wrapper.get('[data-scope-editor] form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1/scope', { personalSpaceId: 'space',
      expectedVersion: 4, reason: 'Applies everywhere', scope: 'global', projectIds: [] })
    expect(getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/knowledge/entity')).length).toBe(2)
    wrapper.unmount()
  })

  it('an edit from a stale page is refused, explained and the page reads the item again', async () => {
    const wrapper = await open()
    patchJson.mockRejectedValue(new ApiError('changed', 409, JSON.stringify({ error: 'changed', code: 'stale_version' })))
    await wrapper.get('#item-content').setValue('Status lines stay short')
    await wrapper.get('#content-reason').setValue('Clearer')
    await wrapper.get('[data-content-editor] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', expect.objectContaining({ action: 'update',
      expectedVersion: 4, name: 'Status lines stay short' }))
    expect(wrapper.get('[data-edit-notice]').text()).toContain('刚被别处改过')
    expect(getJson.mock.calls.filter(([url]) => String(url).startsWith('/api/knowledge/entity')).length).toBe(2)
    wrapper.unmount()
  })

  it('widening an item already in use points to the reviewed decision instead of saving', async () => {
    const wrapper = await open(view({ confirmation_status: 'confirmed',
      scope: { kind: 'projects', projects: [{ id: 'alpha', name: 'Alpha' }], status: 'set' } }))
    postJson.mockRejectedValue(new ApiError('review', 409, JSON.stringify({ error: 'review', code: 'widening_requires_review' })))
    await wrapper.get('[data-scope-choice="global"] [role="radio"]').trigger('click')
    await wrapper.get('#scope-reason').setValue('Everywhere')
    await wrapper.get('[data-scope-editor] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-scope-message]').text()).toContain('审核')
    expect(wrapper.get('[data-scope-message] a').attributes('href')).toBe('/preferences')
    wrapper.unmount()
  })

  it('deactivates the same item with a reason, and a deactivated item keeps only its history', async () => {
    const wrapper = await open()
    patchJson.mockResolvedValue({ id: 'r2' })
    await wrapper.get('#stop-reason').setValue('No longer true')
    await wrapper.get('[data-deactivate] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', { personalSpaceId: 'space', action: 'invalidate',
      reason: 'No longer true', expectedVersion: 4 })
    wrapper.unmount()
    const historical = await open(view({ invalid_at: '2026-10-21T02:00:00Z' }))
    expect(historical.find('[data-scope-editor]').exists()).toBe(false)
    expect(historical.find('[data-content-editor]').exists()).toBe(false)
    expect(historical.find('[data-item-historical]').exists()).toBe(true)
    expect(historical.find('[data-item-history]').exists()).toBe(true)
    historical.unmount()
  })

  it('removes a project tag of the second project of an item from that project, not the first', async () => {
    const wrapper = await open(view({ scope: { kind: 'projects', projects: [{ id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' }], status: 'set' },
    tags: [{ id: 'tb', name: 'beta-only', namespace: 'project', status: 'active', project_id: 'beta' }] }))
    postJson.mockResolvedValue({ outcome: 'detached' })
    await wrapper.get('[data-attached-tags] button').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags', { action: 'detach', personalSpaceId: 'space',
      personalProjectId: 'beta', tagId: 'tb', itemKind: 'entity', itemId: 'item-1' })
    wrapper.unmount()
  })

  it('detaches an attached tag and attaches an existing one from the visible vocabulary', async () => {
    const wrapper = await open()
    postJson.mockResolvedValue({ outcome: 'detached' })
    await wrapper.get('[data-attached-tags] button').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags', { action: 'detach', personalSpaceId: 'space',
      personalProjectId: 'temporary-x', tagId: 't1', itemKind: 'entity', itemId: 'item-1' })
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/knowledge-tags')
      ? { candidates: [{ id: 't2', name: 'brevity', namespace: 'personal', status: 'active', match: 'exact' }] } : view())
    await wrapper.get('#tag-search').setValue('brevity')
    await flushPromises()
    expect(wrapper.find('[data-tag-create]').exists()).toBe(false)
    await wrapper.get('[data-tag-choice="t2"]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge-tags', expect.objectContaining({ action: 'attach', tagId: 't2' }))
    wrapper.unmount()
  })
})

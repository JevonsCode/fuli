import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()), getJson, postJson,
}))

import { ApiError } from '@/api/client'
import KnowledgeItemEditPage from '@/pages/KnowledgeItemEditPage.vue'
import { useConsoleStore } from '@/stores/console'

// rec#5 C9 on the item page: a collapsed danger section, a centred dialog
// that lists exactly what goes and stays, a typed confirmation bound to the
// preview, and 已彻底删除 afterwards and on old links. Synthetic data only.
const PASTED = 'SYNTHETIC-PASTED-KEY-0000-not-a-real-secret'

function view(overrides = {}) {
  return { item_kind: 'entity', item_id: 'item-2', version: 2, title: 'Deploy with a pasted key',
    content: `Deploy with ${PASTED}`, type: 'PersonalPreference', profile_aspect: 'taste', category: 'taste',
    scope: { kind: 'global', projects: [], status: 'set' },
    weight: { percent: 100, basis: { confirmation_status: 'confirmed', confirmed_by_person: true, qualified_use_count: 1,
      distinct_task_count: 1, source_count: 1, negative_evidence_count: 0 } },
    tags: [], confirmation_status: 'confirmed', content_source: 'user_explicit', invalid_at: null, status: 'current',
    evidence: [], evidence_count: 0, revisions: [], versions: [], ...overrides }
}

const counts = { items: 3, versions: 2, relationships: 1, episodes: 2, kept_episodes: 1, dependents: 2, mentions: 3,
  revisions: 4, feedback: 0, usage: 1, change_audits: 2, tags: 1, assignments: 0, references: 0, review_decisions: 0,
  conflicts: 0, promotions: 0, decision_snapshots: 0 }

function preview(id = 'a'.repeat(64), overrides = {}) {
  return { preview_id: id, item_kind: 'entity', item_id: 'item-2', title: 'Deploy with a pasted key',
    items: [
      { item_kind: 'entity', item_id: 'item-2', role: 'item', title: 'Deploy with a pasted key', content: `Deploy with ${PASTED}`, status: 'current' },
      { item_kind: 'entity', item_id: 'item-1', role: 'version', title: 'Deploy', content: 'Deploy (older words)', status: 'superseded' },
      { item_kind: 'relationship', item_id: 'fact-1', role: 'relationship', title: 'DEPLOYS_TO', content: 'Deploy → deploys to → Staging', status: 'current' }],
    removed_episodes: [{ episode_id: 'e2', source_kind: 'task_remember', source_application: 'codex', excerpt: 'pasted turn', other_items: 0,
      created_at: '2026-10-21T00:00:00Z' }, { episode_id: 'e3', source_kind: 'human_knowledge_edit', other_items: 0 }],
    kept_episodes: [{ episode_id: 'e1', source_kind: 'task_remember', source_application: 'codex', other_items: 1 }],
    dependents: [{ item_kind: 'entity', item_id: 'c1', title: 'Smoke checks', content: 'Run the smoke checks after every deploy', direct: true },
      { item_kind: 'entity', item_id: 'c2', title: 'Report', content: 'Post the smoke check summary', direct: false }],
    counts, ...overrides }
}

async function open(read: () => unknown = () => view()) {
  getJson.mockImplementation(async () => read())
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: KnowledgeItemEditPage },
    { path: '/organize', component: { template: '<div />' } }] })
  await router.push('/knowledge/item/space/entity/item-2')
  await router.isReady()
  const wrapper = mount(KnowledgeItemEditPage, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

const dialog = () => document.body.querySelector<HTMLElement>('[data-hard-delete-dialog]')

async function openDialog(wrapper: Awaited<ReturnType<typeof open>>) {
  await wrapper.get('[data-hard-delete-toggle] button').trigger('click')
  await wrapper.get('[data-hard-delete-open]').trigger('click')
  await flushPromises()
}

async function type(value: string) {
  const input = dialog()!.querySelector<HTMLInputElement>('[data-hard-delete-confirm]')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

async function submit() {
  dialog()!.querySelector('form')!.dispatchEvent(new Event('submit'))
  await flushPromises()
}

beforeEach(() => {
  getJson.mockReset()
  postJson.mockReset()
  document.body.innerHTML = ''
})

describe('permanent delete on the item page', () => {
  it('sits collapsed at the end of the page and lists exactly what goes, what stays and what rests on it', async () => {
    let answer: (value: unknown) => void = () => {}
    postJson.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const wrapper = await open()
    expect(wrapper.get('[data-hard-delete-toggle] button').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-hard-delete-open]').exists()).toBe(false)
    await openDialog(wrapper)
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/entity/item-2/hard-delete/preview', { personalSpaceId: 'space' })
    expect(dialog()!.textContent).toContain('正在列出将彻底删除的内容')
    answer(preview())
    await flushPromises()
    const shown = dialog()!
    expect([...shown.querySelectorAll('[data-hard-delete-item]')].map((row) => row.getAttribute('data-hard-delete-item')))
      .toEqual(['item', 'version', 'relationship'])
    expect(shown.querySelector('[data-hard-delete-sources]')!.textContent).toContain('2 段只属于它的原文会删除')
    expect(shown.querySelector('[data-hard-delete-sources]')!.textContent).toContain('1 段原文还被其他知识使用，会保留')
    expect(shown.querySelectorAll('[data-hard-delete-episode="kept"]')).toHaveLength(1)
    expect(shown.querySelector('[data-hard-delete-dependents]')!.textContent).toContain('这 2 条会保留，但在你复核前不再交付给 Agent')
    expect(shown.querySelector('[data-hard-delete-dependents]')!.textContent).toContain('间接')
    expect([...shown.querySelectorAll('[data-hard-delete-count]')].map((row) => row.getAttribute('data-hard-delete-count')))
      .toEqual(['mentions', 'revisions', 'usage', 'change_audits', 'tags'])
    expect(shown.querySelector('[data-hard-delete-kept]')!.textContent).toContain('已经发布到公开项目的内容不会自动撤回')
    const button = shown.querySelector<HTMLButtonElement>('[data-hard-delete-submit]')!
    expect(button.disabled).toBe(true)
    await type('ok')
    expect(button.disabled).toBe(true)
    await type('删除')
    expect(button.disabled).toBe(false)
    wrapper.unmount()
  })

  it('confirms the preview it showed, then says 已彻底删除 without the deleted words', async () => {
    let finish: (value: unknown) => void = () => {}
    postJson.mockImplementation((url: string) => url.endsWith('/preview') ? Promise.resolve(preview())
      : new Promise((resolve) => { finish = resolve }))
    const wrapper = await open()
    await openDialog(wrapper)
    await type('删除')
    await submit()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge/entity/item-2/hard-delete', {
      personalSpaceId: 'space', previewId: 'a'.repeat(64), confirmation: '删除' })
    expect(dialog()!.querySelector('[data-hard-delete-submit]')!.textContent).toContain('正在彻底删除这条知识')
    finish({ deletion_id: 'd1', item_kind: 'entity', item_id: 'item-2', deleted_at: '2026-10-22T01:02:03Z', counts,
      deleted_item_ids: ['item-2', 'item-1', 'fact-1'], local_stores: [{ store: 'judgment.sqlite', status: 'forgotten', changed: 1 }] })
    await flushPromises()
    expect(dialog()).toBeNull()
    expect(wrapper.get('[data-hard-deleted]').text()).toContain('这条知识已被你彻底删除')
    expect(wrapper.get('[data-hard-deleted-count]').text()).toBe('已彻底删除 3 项。')
    expect(wrapper.find('[data-hard-deleted-local-failed]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(PASTED)
    expect(wrapper.find('[data-hard-delete-section]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('a stale preview lists again from what is stored now and needs a new confirmation', async () => {
    const fresh = 'b'.repeat(64)
    postJson.mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new ApiError('stale', 409, JSON.stringify({ code: 'hard_delete_preview_stale', error: 'changed' })))
      .mockResolvedValueOnce(preview(fresh, { counts: { ...counts, usage: 2 } }))
      .mockResolvedValueOnce({ deletion_id: 'd1', item_kind: 'entity', item_id: 'item-2', deleted_at: '2026-10-22T01:02:03Z',
        counts, deleted_item_ids: ['item-2'], local_stores: [{ store: 'judgment.sqlite', status: 'failed', reason: 'synthetic newer format' }] })
    const wrapper = await open()
    await openDialog(wrapper)
    await type('删除')
    await submit()
    expect(postJson).toHaveBeenCalledTimes(3)
    expect(dialog()!.querySelector('[data-hard-delete-notice]')!.textContent).toContain('预览之后内容有变化')
    expect(dialog()!.querySelector<HTMLInputElement>('[data-hard-delete-confirm]')!.value).toBe('')
    expect(dialog()!.querySelector<HTMLButtonElement>('[data-hard-delete-submit]')!.disabled).toBe(true)
    await type('删除')
    await submit()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge/entity/item-2/hard-delete', {
      personalSpaceId: 'space', previewId: fresh, confirmation: '删除' })
    expect(wrapper.get('[data-hard-deleted-local-failed]').text()).toContain('judgment.sqlite')
    wrapper.unmount()
  })

  it('an old link to a deleted item shows 已彻底删除 and when, not a load error', async () => {
    const wrapper = await open(() => {
      throw new ApiError('gone', 410, JSON.stringify({ error: 'deleted', code: 'hard_deleted', deletedAt: '2026-10-22T01:02:03Z' }))
    })
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.get('[data-hard-deleted]').text()).toContain('只保留了删除时间和数量')
    expect(wrapper.get('[data-hard-deleted-when]').text()).toContain('删除时间')
    expect(wrapper.find('[data-hard-deleted-count]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('a conclusion names a deleted basis as deleted, without its words', async () => {
    const wrapper = await open(() => view({ item_id: 'c1', basis_review: 'changed',
      bases: [{ item_kind: 'entity', item_id: 'item-2', content: '', status: 'deleted' }] }))
    expect(wrapper.get('[data-item-bases]').text()).toContain('已彻底删除')
    expect(wrapper.get('[data-item-bases]').text()).toContain('已彻底删除的依据')
    wrapper.unmount()
  })
})

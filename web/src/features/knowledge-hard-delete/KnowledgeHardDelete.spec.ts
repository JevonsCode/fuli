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
    kept_episodes: [{ episode_id: 'e1', source_kind: 'task_remember', source_application: 'codex', other_items: 1,
      excerpt: '预发环境在 staging 集群', used_by: [{ item_kind: 'entity', item_id: 'other', title: 'Synthetic staging target' }] }],
    dependents: [{ item_kind: 'entity', item_id: 'c1', title: 'Smoke checks', content: 'Run the smoke checks after every deploy', direct: true },
      { item_kind: 'entity', item_id: 'c2', title: 'Report', content: 'Post the smoke check summary', direct: false }],
    counts, ...overrides }
}

function deletedResult(overrides = {}) {
  return { outcome: 'complete', deletion_id: 'd1', item_kind: 'entity', item_id: 'item-2', deleted_at: '2026-10-22T01:02:03Z', counts,
    deleted_item_ids: ['item-2', 'item-1', 'fact-1'], local_stores: [{ store: 'judgment.sqlite', status: 'forgotten', changed: 1 }],
    ...overrides }
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
    finish(deletedResult())
    await flushPromises()
    expect(dialog()).toBeNull()
    const notice = wrapper.get('[data-hard-deleted]')
    expect(notice.attributes('data-hard-deleted-state')).toBe('complete')
    expect(notice.text()).toContain('这条知识已被你彻底删除')
    expect(wrapper.get('[data-hard-deleted-count]').text()).toBe('已彻底删除 3 条知识、2 段原文。')
    expect(wrapper.get('[data-hard-deleted-exceptions]').text()).toContain('工作流候选里记下的步骤名称')
    expect(wrapper.get('[data-hard-deleted-disclosure]').text()).toContain('你之前做的格式备份里仍然有它，需要你自己删除')
    expect(wrapper.get('a[data-hard-deleted-backups]').attributes('href')).toBe('/settings/data-format')
    expect(wrapper.find('[data-hard-deleted-local-failed]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(PASTED)
    expect(wrapper.find('[data-hard-delete-section]').exists()).toBe(false)
    // A complete delete needs no second look.
    expect(postJson.mock.calls.some(([url]) => String(url).endsWith('/status'))).toBe(false)
    wrapper.unmount()
  })

  it('a stale preview lists again from what is stored now and needs a new confirmation', async () => {
    const fresh = 'b'.repeat(64)
    postJson.mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new ApiError('stale', 409, JSON.stringify({ code: 'hard_delete_preview_stale', error: 'changed' })))
      .mockResolvedValueOnce(preview(fresh, { counts: { ...counts, usage: 2 } }))
      .mockResolvedValueOnce(deletedResult({ outcome: 'local_pending',
        local_stores: [{ store: 'judgment.sqlite', status: 'failed', reason: 'synthetic newer format' }] }))
      .mockResolvedValueOnce(deletedResult({ outcome: 'local_pending',
        local_stores: [{ store: 'judgment.sqlite', status: 'failed', reason: 'synthetic newer format' }] }))
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
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/entity/item-2/hard-delete', {
      personalSpaceId: 'space', previewId: fresh, confirmation: '删除' })
    // Deleted from the graph, local cleanup left: said so, with its retry.
    expect(wrapper.get('[data-hard-deleted]').attributes('data-hard-deleted-state')).toBe('local_pending')
    expect(wrapper.get('[data-hard-deleted-local-pending]').text()).toContain('图谱里已经删除，本机记录还没清理完')
    expect(wrapper.get('[data-hard-deleted-local-failed]').text()).toContain('judgment.sqlite')
    expect(wrapper.find('[data-hard-deleted-retry]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('a lost answer is never "nothing was deleted": the page checks, then shows what the graph says', async () => {
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return preview()
      if (url.endsWith('/hard-delete')) throw new TypeError('Failed to fetch')
      return { outcome: 'unknown', item_kind: 'entity', item_id: 'item-2' }
    })
    const wrapper = await open()
    await openDialog(wrapper)
    await type('删除')
    await submit()
    expect(dialog()).toBeNull()
    expect(wrapper.text()).not.toContain('没有删除')
    expect(wrapper.get('[data-hard-deleted]').attributes('data-hard-deleted-state')).toBe('unknown')
    expect(wrapper.get('[data-hard-deleted-unknown]').text()).toContain('FULI 不会再发一次删除，只会去核对')
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge/entity/item-2/hard-delete/status', { personalSpaceId: 'space' })
    // The graph answers on the second look: it was deleted.
    postJson.mockImplementation(async () => deletedResult())
    await wrapper.get('[data-hard-deleted-recheck]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-hard-deleted]').attributes('data-hard-deleted-state')).toBe('complete')
    expect(wrapper.get('[data-hard-deleted-count]').text()).toBe('已彻底删除 3 条知识、2 段原文。')
    wrapper.unmount()
  })

  it('only the graph\'s own refusal says nothing was deleted; a check that finds it there shows it again', async () => {
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return preview()
      throw new ApiError('refused', 422, JSON.stringify({ error: 'type 删除 or the item title', code: 'hard_delete_unconfirmed' }))
    })
    const wrapper = await open()
    await openDialog(wrapper)
    await type('删除')
    await submit()
    expect(dialog()!.querySelector('[data-hard-delete-error]')!.textContent).toContain('没有删除')
    wrapper.unmount()
    // Unknown first, then proven still there: the item comes back with a note.
    document.body.innerHTML = ''
    postJson.mockReset()
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return preview()
      if (url.endsWith('/hard-delete')) throw new TypeError('Failed to fetch')
      return { outcome: 'not_deleted', item_kind: 'entity', item_id: 'item-2' }
    })
    const again = await open()
    await openDialog(again)
    await type('删除')
    await submit()
    await flushPromises()
    expect(again.find('[data-hard-deleted]').exists()).toBe(false)
    expect(again.get('[data-edit-notice]').text()).toBe('核对过了：这条知识没有被删除。')
    again.unmount()
  })

  it('an old link to a deleted item shows 已彻底删除 and when, and finishes any cleanup left', async () => {
    postJson.mockResolvedValue(deletedResult())
    const wrapper = await open(() => {
      throw new ApiError('gone', 410, JSON.stringify({ error: 'deleted', code: 'hard_deleted', deletedAt: '2026-10-22T01:02:03Z' }))
    })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/entity/item-2/hard-delete/status', { personalSpaceId: 'space' })
    expect(wrapper.get('[data-hard-deleted]').text()).toContain('只保留了删除时间和数量')
    expect(wrapper.get('[data-hard-deleted-when]').text()).toContain('删除时间')
    expect(wrapper.get('[data-hard-deleted-disclosure]').text()).toContain('数据库内部文件和事务日志里可能还残留字节')
    wrapper.unmount()
  })

  it('the preview shows a kept source\'s words and links to what still uses it, and links the conclusions', async () => {
    postJson.mockResolvedValue(preview())
    const wrapper = await open()
    await openDialog(wrapper)
    const kept = dialog()!.querySelector('[data-hard-delete-episode="kept"]')!
    expect(kept.textContent).toContain('预发环境在 staging 集群')
    const users = [...kept.querySelectorAll<HTMLAnchorElement>('[data-hard-delete-kept-user]')]
    expect(users.map((link) => [link.textContent?.trim(), link.getAttribute('href')])).toEqual([
      ['Synthetic staging target', '/knowledge/item/space/entity/other']])
    expect(dialog()!.textContent).toContain('打开下面的知识，把它们也删除')
    const conclusions = [...dialog()!.querySelectorAll<HTMLAnchorElement>('[data-hard-delete-dependent-link]')]
    expect(conclusions.map((link) => link.getAttribute('href'))).toEqual([
      '/knowledge/item/space/entity/c1', '/knowledge/item/space/entity/c2'])
    const disclosure = dialog()!.querySelector('[data-hard-delete-disclosure]')!.textContent!
    expect(disclosure).toContain('除了上面这几处')
    expect(dialog()!.querySelector('[data-hard-delete-kept]')!.textContent).toContain('它两端条目自己的摘要不会改')
    expect(dialog()!.textContent).toContain('下面列出会删除和保留的内容；确认后不能撤销。')
    wrapper.unmount()
  })

  it('a damaged record of permanent deletes stops the delete and says how to repair it', async () => {
    const repair = 'The record of permanent deletes (knowledge-hard-deletes.json) is damaged: its operations are not a list. Repair it by restoring it from a format backup.'
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return preview()
      throw new ApiError('unavailable', 503, JSON.stringify({ error: repair, code: 'data_format_damaged' }))
    })
    const wrapper = await open()
    await openDialog(wrapper)
    await type('删除')
    await submit()
    expect(dialog()!.querySelector('[data-hard-delete-error]')!.textContent).toContain('restoring it from a format backup')
    expect(wrapper.find('[data-hard-deleted]').exists()).toBe(false)
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


it('shows public submission provenance above the deletion layers without inventing a withdrawal link', async () => {
  postJson.mockResolvedValue(preview(undefined, { publications: [{ draft_id: 'draft', project_id: 'opaque-project-id', project_name: 'Synthetic public project',
    provider_url: 'https://public.example', proposal_id: 'proposal', source_episode_ids: ['e1'], status: 'submitted',
    local_delete_retracts: false, withdrawal_status: 'unavailable', withdrawal_url: null }] }))
  const wrapper = await open()
  await openDialog(wrapper)
  const warning = dialog()!.querySelector('[data-hard-delete-publications]')!
  expect(warning).not.toBeNull()
  expect(warning.textContent).toContain('Synthetic public project')
  expect(warning.textContent).toContain('删除来源不会撤回公开内容')
  expect(warning.textContent).toContain('公开项目里的副本会原样保留')
  expect(warning.textContent).toContain('FULI 还不能替你撤回')
  expect(warning.textContent).toContain('位置 https://public.example · 提交编号 proposal')
  expect(warning.textContent).not.toContain('opaque-project-id')
  expect(dialog()!.querySelector('[data-hard-delete-kept]')!.textContent).not.toContain('需要在公开项目里单独撤回')
  expect(warning.querySelector('a')).toBeNull()
  expect(warning.compareDocumentPosition(dialog()!.querySelector('[data-hard-delete-items]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  wrapper.unmount()
})

it('lists multiple public submissions with a single warning and falls back to the project ID', async () => {
  const publication = { draft_id: 'first', project_id: 'fallback-id', provider_url: 'https://public.example',
    proposal_id: 'proposal', source_episode_ids: ['e1'], status: 'submitted' as const,
    local_delete_retracts: false as const, withdrawal_status: 'unavailable' as const, withdrawal_url: null }
  postJson.mockResolvedValue(preview(undefined, { publications: [publication,
    { ...publication, draft_id: 'second', project_id: 'second-id', project_name: 'Readable project' }] }))
  const wrapper = await open()
  await openDialog(wrapper)
  const warning = dialog()!.querySelector('[data-hard-delete-publications]')!
  expect(warning.querySelectorAll('li')).toHaveLength(2)
  expect(warning.textContent).toContain('fallback-id / Readable project')
  expect(warning.textContent!.match(/删除来源不会撤回公开内容/g)).toHaveLength(1)
  expect(warning.querySelector('a')).toBeNull()
  wrapper.unmount()
})

it('explains pending draft invalidation under sources and submitted local text erasure under the public warning', async () => {
  postJson.mockResolvedValue(preview(undefined, { drafts: { pending: 2, submitted: 1 }, publications: [{
    draft_id: 'submitted', project_id: 'public-project', provider_url: 'https://public.example', proposal_id: 'proposal',
    source_episode_ids: ['e2'], status: 'submitted', local_delete_retracts: false, withdrawal_status: 'unavailable', withdrawal_url: null,
  }] }))
  const wrapper = await open()
  await openDialog(wrapper)
  expect(dialog()!.querySelector('[data-hard-delete-sources]')!.textContent).toContain('2 份还没提交的公开草稿会一起作废，之后不能再提交。')
  expect(dialog()!.querySelector('[data-hard-delete-publications]')!.textContent).toContain('FULI 本机留下的提交副本会清掉正文，只保留提交记录。')
  wrapper.unmount()
})

it('does not claim local drafts are erased when their shared source stays', async () => {
  postJson.mockResolvedValue(preview(undefined, { drafts: { pending: 0, submitted: 0 }, removed_episodes: [], publications: [{
    draft_id: 'shared', project_id: 'public-project', provider_url: 'https://public.example', proposal_id: 'proposal',
    source_episode_ids: ['e1'], status: 'submitted', local_delete_retracts: false, withdrawal_status: 'unavailable', withdrawal_url: null,
  }] }))
  const wrapper = await open()
  await openDialog(wrapper)
  expect(dialog()!.textContent).not.toContain('公开草稿会一起作废')
  expect(dialog()!.textContent).not.toContain('提交副本会清掉正文')
  expect(dialog()!.textContent).toContain('删除这条知识不会撤回公开内容')
  wrapper.unmount()
})

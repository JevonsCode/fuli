import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent } from 'vue'
const postJson = vi.hoisted(() => vi.fn())
const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), postJson, getJson }))
import { ApiError } from '@/api/client'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import KnowledgeHardDeleteSection from './KnowledgeHardDeleteSection.vue'
import SourceDeleteControl from './SourceDeleteControl.vue'
import SessionRecordPeek from '@/features/session-records/SessionRecordPeek.vue'
import SessionRecordsPage from '@/pages/SessionRecordsPage.vue'
import KnowledgeItemEditPage from '@/pages/KnowledgeItemEditPage.vue'
import { useConsoleStore } from '@/stores/console'
import { setLocale } from '@/i18n'
import { sourceRowTitle } from './source-delete-model'
import { hardDeleteStatus } from './hard-delete-api'
import type { SourceDeletePreview, SourceDeleteTarget } from './source-delete-model'
import type { SessionRecordsView, SessionEntry } from '@/features/session-records/model'

const target: SourceDeleteTarget = { item_kind: 'episode', item_id: 'source/opaque' }
const counts = { items: 2, versions: 2, relationships: 0, episodes: 1, kept_episodes: 0, dependents: 1,
  mentions: 0, revisions: 0, feedback: 0, usage: 0, change_audits: 0, tags: 0, assignments: 0, references: 0,
  review_decisions: 0, conflicts: 0, promotions: 0, decision_snapshots: 0,
  source_turns: 1, conversation_events: 2, conversation_summaries: 1 }
function preview(overrides = {}): SourceDeletePreview {
  return { ...target, preview_id: 'digest-1', title: 'Synthetic source', include: [], exclude: [],
    source_application: null, fuli_session_id: null, counts,
    default_items: [{ key: 'entity:head', selected: true, reason: 'sole_source', basis_changed: false,
      source_count: 1, retained_source_count: 0, versions: [
        { item_kind: 'entity', item_id: 'old', role: 'version', title: 'Old', content: 'Older version', status: 'superseded' },
        { item_kind: 'entity', item_id: 'head', role: 'item', title: 'Head', content: 'Current version', status: 'current' }] }],
    affected_items: [{ key: 'entity:other', selected: false, reason: 'multiple_sources', basis_changed: true,
      source_count: 2, retained_source_count: 1,
      versions: [{ item_kind: 'entity', item_id: 'other', role: 'item', title: 'Other', content: 'Retained candidate', status: 'current' }] }],
    removed_episodes: [{ episode_id: target.item_id, excerpt: 'SYNTHETIC SOURCE BODY', other_items: 0 }], ...overrides }
}
const wrappers: ReturnType<typeof mount>[] = []
async function router() {
  const result = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await result.push('/')
  await result.isReady()
  return result
}
async function open(value = target) {
  const wrapper = mount(SourceDeleteControl, { props: { target: value, spaceId: 'space' }, attachTo: document.body,
    global: { plugins: [await router()] } })
  wrappers.push(wrapper)
  await wrapper.get('[data-source-delete-open]').trigger('click')
  await flushPromises()
  return wrapper
}
const dialog = () => document.body.querySelector<HTMLElement>('[data-source-delete-dialog], [data-hard-delete-dialog]')!
async function choose(key: string) {
  dialog().querySelector<HTMLButtonElement>(`[data-source-row="${key}"] [role="checkbox"]`)!.click()
  await flushPromises()
}
async function submit() { dialog().querySelector('form')!.dispatchEvent(new Event('submit')); await flushPromises() }
const disabled = () => dialog().querySelector<HTMLButtonElement>('[data-hard-delete-submit]')!.disabled

beforeEach(() => { vi.resetAllMocks(); document.body.innerHTML = ''; setLocale('zh-CN', { persist: false }) })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount() })

describe('source deletion uses the authoritative two-layer preview', () => {
  it('repreviews canonical row keys, holds confirmation while listing, and sends only the latest digest and selection', async () => {
    let finish!: (value: SourceDeletePreview) => void
    postJson.mockResolvedValueOnce(preview()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
    await open()
    expect(dialog().textContent).toContain('Older version')
    expect(dialog().querySelectorAll('[data-source-layer]')).toHaveLength(2)
    expect(dialog().querySelector('[data-source-basis-changed]')).not.toBeNull()
    expect(disabled()).toBe(false)
    await choose('entity:other')
    expect(disabled()).toBe(true)
    expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete/preview',
      { personalSpaceId: 'space', include: ['entity:other'], exclude: [] }])
    await submit()
    expect(postJson).toHaveBeenCalledTimes(2)
    finish(preview({ preview_id: 'digest-2', include: ['entity:other'] }))
    await flushPromises()
    expect(disabled()).toBe(false)
    await submit()
    expect(postJson.mock.calls[2]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete',
      { personalSpaceId: 'space', include: ['entity:other'], exclude: [], previewId: 'digest-2', confirmation: '删除' }])
    expect(document.body.textContent).not.toContain('SYNTHETIC SOURCE BODY')
  })

  it('a rejected selection never permits confirming the previous preview', async () => {
    postJson.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new ApiError('invalid selection', 400, '{"code":"invalid_selection"}'))
    await open(); await choose('entity:head')
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', include: [], exclude: ['entity:head'] })
    await submit()
    expect(disabled()).toBe(true)
    expect(postJson).toHaveBeenCalledTimes(2)
    expect(dialog().querySelector('[data-hard-delete-error]')).not.toBeNull()
  })

  it('a graph change requires a new preview and another click, never a resend', async () => {
    postJson.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new ApiError('changed', 409, '{"code":"hard_delete_preview_stale"}'))
      .mockResolvedValueOnce(preview({ preview_id: 'changed-digest' }))
    await open(); await submit()
    expect(postJson).toHaveBeenCalledTimes(3)
    expect(disabled()).toBe(false)
  })

  it('disables selected attached relationships while allowing endpoint retention', async () => {
    const value = preview()
    value.default_items.push({ ...value.default_items[0]!, key: 'relationship:edge', reason: 'attached_relationship' })
    postJson.mockResolvedValue(value)
    await open()
    expect(dialog().querySelector<HTMLButtonElement>('[data-source-row="relationship:edge"] [role="checkbox"]')!.disabled).toBe(true)
    expect(dialog().querySelector<HTMLButtonElement>('[data-source-row="entity:head"] [role="checkbox"]')!.disabled).toBe(false)
  })

  it('uses the supplied session target and tuple, but status sends only personalSpaceId', async () => {
    const session: SourceDeleteTarget = { item_kind: 'session', item_id: 'opaque-provider-target', sourceApplication: 'codex', sessionId: 'synthetic-session' }
    postJson.mockResolvedValueOnce(preview({ ...session, source_application: 'codex', fuli_session_id: 'synthetic-session' }))
      .mockResolvedValueOnce({ outcome: 'complete', ...session, counts }).mockResolvedValueOnce({ outcome: 'complete' })
    await open(session); await submit()
    expect(postJson.mock.calls[0]).toEqual(['/api/knowledge/session/opaque-provider-target/hard-delete/preview',
      { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'synthetic-session', include: [], exclude: [] }])
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'synthetic-session',
      include: [], exclude: [], previewId: 'digest-1', confirmation: '删除' })
    await hardDeleteStatus('space', session)
    expect(postJson.mock.calls[2]).toEqual(['/api/knowledge/session/opaque-provider-target/hard-delete/status', { personalSpaceId: 'space' }])
  })
})

const entry: SessionEntry = { number: 1, key: 'entity:head', kind: 'entity', type: 'Note', group: 'knowledge',
  summary: 'SYNTHETIC', project: null, link: '', detail: { sources: [{ episode_id: 'actual-episode', turn: 'turn:one' }] } }
async function peek(view: SessionRecordsView, selected = entry) {
  const host = defineComponent({ components: { Dialog, DialogContent, SessionRecordPeek }, setup: () => ({ view, entry: selected }),
    template: '<Dialog open><DialogContent><SessionRecordPeek :entry="entry" :view="view" space-id="space" /></DialogContent></Dialog>' })
  const wrapper = mount(host, { attachTo: document.body, global: { plugins: [await router()] } })
  wrappers.push(wrapper); await flushPromises(); return wrapper
}

it('shows episode IDs from evidence and no whole-session action without the Provider target', async () => {
  const view: SessionRecordsView = { session: { sourceApplication: 'codex', sessionId: 'session', url: '' },
    entries: [entry], total: 1, stretches: [], truncated: false }
  const wrapper = await peek(view)
  expect(document.body.querySelector('[data-source-delete-open="episode"]')).not.toBeNull()
  expect(document.body.querySelector('[data-source-delete-open="session"]')).toBeNull()
  wrapper.unmount()
  await peek({ ...view, session: { ...view.session, deletionTargetId: 'provider-opaque' } })
  expect(document.body.querySelector('[data-source-delete-open="session"]')).toBeNull()
})

it('clears item content and source excerpts after a source deletion with unknown result', async () => {
  getJson.mockResolvedValue({ item_kind: 'entity', item_id: 'head', title: 'SYNTHETIC ITEM BODY', content: 'SYNTHETIC ITEM BODY',
    version: 1, type: 'Note', status: 'current', scope: { kind: 'global', projects: [], status: 'set' }, tags: [],
    weight: { percent: 100, basis: {} }, evidence: [{ episode_id: target.item_id, excerpt: 'SYNTHETIC SOURCE BODY' }],
    evidence_count: 1, revisions: [], versions: [] })
  postJson.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValue({ outcome: 'unknown', ...target })
  const pinia = createPinia(); setActivePinia(pinia)
  useConsoleStore().state = { activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: 'Synthetic' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const route = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: KnowledgeItemEditPage }] })
  await route.push('/knowledge/item/space/entity/head'); await route.isReady()
  const wrapper = mount(KnowledgeItemEditPage, { attachTo: document.body, global: { plugins: [pinia, route] } }); wrappers.push(wrapper)
  await flushPromises()
  await wrapper.get('[data-source-delete-open="episode"]').trigger('click'); await flushPromises()
  await submit()
  expect(wrapper.find('[data-source-deleted-page]').exists()).toBe(true)
  expect(document.body.textContent).not.toContain('SYNTHETIC ITEM BODY')
  expect(document.body.textContent).not.toContain('SYNTHETIC SOURCE BODY')
  expect(postJson.mock.calls.filter(([path]) => path.endsWith('/hard-delete'))).toHaveLength(1)
  expect(postJson.mock.calls.at(-1)).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete/status', { personalSpaceId: 'space' }])
})


it('unchecking an affected row repreviews without an invalid default-layer exclusion', async () => {
  const selected = preview({ preview_id: 'digest-selected', include: ['entity:other'] })
  selected.affected_items[0]!.selected = true
  postJson.mockResolvedValueOnce(preview()).mockResolvedValueOnce(selected).mockResolvedValueOnce(preview())
  await open(); await choose('entity:other'); await choose('entity:other')
  expect(postJson.mock.calls[2]?.[1]).toEqual({ personalSpaceId: 'space', include: [], exclude: [] })
  expect(postJson.mock.calls.every(([path]) => path.endsWith('/preview'))).toBe(true)
})


it('deletes a whole session with no visible records using its Provider target and clears the old view', async () => {
  getJson.mockResolvedValue({ session: { sourceApplication: 'codex', sessionId: 'session-one', deletionTargetId: 'opaque-session', url: '' },
    total: 0, entries: [], stretches: [], truncated: false })
  postJson.mockResolvedValueOnce(preview({ item_kind: 'session', item_id: 'opaque-session', source_application: 'codex', fuli_session_id: 'session-one' }))
    .mockResolvedValueOnce({ outcome: 'complete', item_kind: 'session', item_id: 'opaque-session', counts })
  const pinia = createPinia(); setActivePinia(pinia)
  useConsoleStore().state = { activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: 'Synthetic' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const route = createRouter({ history: createMemoryHistory(), routes: [ { path: '/s/:sessionId', component: SessionRecordsPage } ] })
  await route.push('/s/session-one'); await route.isReady()
  const wrapper = mount(SessionRecordsPage, { attachTo: document.body, global: { plugins: [pinia, route] } }); wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.get('[data-session-records]').element.lastElementChild?.hasAttribute('data-hard-delete-section')).toBe(true)
  expect(wrapper.find('[data-source-delete-open="session"]').exists()).toBe(false)
  await wrapper.get('[data-hard-delete-open]').trigger('click'); await flushPromises()
  await submit()
  expect(wrapper.find('[data-source-deleted-page]').exists()).toBe(true)
  expect(wrapper.find('[data-session-total]').exists()).toBe(false)
  expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/session/opaque-session/hard-delete', {
    personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'session-one', include: [], exclude: [], previewId: 'digest-1', confirmation: '删除',
  }])
})


it.each(['source', 'item'])('keeps the %s delete mounted while confirmation is pending, including Escape dismissal', async kind => {
  let finish!: (value: unknown) => void
  const normal = { item_kind: 'entity', item_id: 'head', title: 'Synthetic item' }
  postJson.mockResolvedValueOnce(kind === 'source' ? preview() : { ...preview(), ...normal, items: [], kept_episodes: [], dependents: [] })
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ outcome: 'unknown', ...(kind === 'source' ? target : normal) })
  let wrapper
  if (kind === 'source') wrapper = await open()
  else {
    wrapper = mount(KnowledgeHardDeleteSection, { props: { item: normal as never, spaceId: 'space' }, attachTo: document.body,
      global: { plugins: [await router()] } })
    wrappers.push(wrapper)
    await wrapper.get('[data-hard-delete-open]').trigger('click'); await flushPromises()
  }
  await submit()
  const close = dialog().querySelector<HTMLButtonElement>('button.absolute')
  close?.click()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flushPromises()
  expect(dialog()).not.toBeNull()
  expect(dialog().querySelector('button.absolute')).toBeNull()
  finish({ outcome: 'unknown', ...(kind === 'source' ? target : normal) }); await flushPromises()
  expect(wrapper.emitted('deleted')?.[0]?.[0]).toMatchObject({ outcome: 'unknown' })
  expect(dialog()).toBeNull()
})

it('recognizes the Provider source_hard_deleted response and checks status instead of keeping the preview', async () => {
  postJson.mockRejectedValueOnce(new ApiError('source deleted', 410, '{"code":"source_hard_deleted"}'))
    .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
  const wrapper = await open()
  expect(wrapper.emitted('deleted')?.[0]?.[0]).toMatchObject({ outcome: 'gone' })
  expect(dialog()).toBeNull()
  expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete/status', { personalSpaceId: 'space' }])
})


it('labels the row by its current version and falls back to its first sentence, never its opaque key', async () => {
  const value = preview()
  expect(sourceRowTitle(value.default_items[0]!)).toBe('Head')
  value.default_items[0]!.versions[1]!.title = ''
  value.default_items[0]!.versions[1]!.content = 'Current first sentence. More content.'
  expect(sourceRowTitle(value.default_items[0]!)).toBe('Current first sentence.')
  postJson.mockResolvedValue(value)
  await open()
  const row = dialog().querySelector('[data-source-row="entity:head"]')!
  expect(row.querySelector('label')!.textContent).toContain('Current first sentence.')
  expect(row.querySelector('[role="checkbox"]')!.getAttribute('aria-label')).toBe('删除知识：Current first sentence.')
})

it.each(['zh-CN', 'en-US'] as const)('orders source sections and distinguishes selection refresh in %s', async locale => {
  setLocale(locale, { persist: false })
  const value = preview({ drafts: { pending: 2, submitted: 1, submitting: 0, unknown: 0 }, publications: [{
    draft_id: 'draft', project_id: 'Synthetic public', provider_url: 'https://synthetic.invalid', proposal_id: 'proposal',
    source_episode_ids: ['source/opaque'], status: 'submitted', local_delete_retracts: false, withdrawal_status: 'unavailable', withdrawal_url: null,
  }] })
  let finish!: (value: SourceDeletePreview) => void
  postJson.mockResolvedValueOnce(value).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await open();  const area = dialog().querySelector('[data-hard-delete-preview]')!
  const sequence = [...area.children].filter(node => node.matches('section,form')).map(node => node.tagName === 'FORM' ? 'confirm'
    : node.hasAttribute('data-source-layer') ? node.getAttribute('data-source-layer') : [...node.attributes].find(attr => attr.name.startsWith('data-hard-delete'))?.name)
  expect(sequence).toEqual(['data-hard-delete-publications', 'data-hard-delete-sources', 'default_items', 'affected_items', 'data-hard-delete-records', 'data-hard-delete-kept', 'confirm'])
  const sources = area.querySelector('[data-hard-delete-sources]')!
  const publicBlock = area.querySelector('[data-hard-delete-publications]')!
  const copy = locale === 'zh-CN' ? 'FULI 本机留下的提交副本会清掉正文，只保留提交记录。' : "FULI's local copy of the submission loses its text; only the submission record stays."
  expect(publicBlock.lastElementChild?.textContent).toBe(copy)
  expect(sources.textContent).not.toContain(copy)
  expect(publicBlock.querySelector('p')?.textContent).toBe(locale === 'zh-CN'
    ? '所选来源原文已提交到公开项目 Synthetic public。删除来源不会撤回公开内容，公开项目里的副本会原样保留。'
    : 'The selected source text was submitted to public project Synthetic public. Deleting the source does not retract it; the public copy stays as it is.')
  expect(area.querySelector('form')!.textContent).not.toContain(locale === 'zh-CN' ? '也可以输入这条知识的标题' : 'You can also type the item title')
  expect(sources.querySelector('[data-source-conversation-counts]')?.previousElementSibling?.textContent).toContain(locale === 'zh-CN' ? '所选范围内' : 'selected scope')
  expect(area.querySelector('a')).toBeNull()
  await choose('entity:other')
  expect(area.textContent).toContain(locale === 'zh-CN' ? '正在按新选择重新列出将删除的内容' : 'Listing what will be deleted for the new selection')
  expect(area.textContent).toContain(locale === 'zh-CN' ? '选择已改变，下面是按新选择列出的内容。' : 'The selection changed; the list below follows it.')
  const selected = preview({ include: ['entity:other'] }); selected.affected_items[0]!.selected = true
  finish(selected); await flushPromises()
  const row = area.querySelector('[data-source-row="entity:other"]')!
  expect(row.textContent).toContain(locale === 'zh-CN' ? '已加入删除：这条知识的全部版本会一起删除；它另外 1 段来源不在范围内，会保留。' : 'Added to the deletion: every version of this knowledge will be deleted; its other 1 sources are outside this scope and stay.')
  expect(row.querySelector('label')!.textContent).not.toContain(locale === 'zh-CN' ? '删除后保留' : 'remain after deletion')
  expect(disabled()).toBe(false)
})

it.each(['zh-CN', 'en-US'] as const)('blocks submitting drafts but permits unknown submissions in %s', async locale => {
  setLocale(locale, { persist: false })
  postJson.mockResolvedValueOnce(preview({ drafts: { pending: 0, submitted: 0, submitting: 2, unknown: 3 } }))
  const wrapper = await open();  const sources = dialog().querySelector('[data-hard-delete-sources]')!
  expect(sources.querySelector('[data-drafts-submitting]')!.textContent).toBe(locale === 'zh-CN'
    ? '2 份公开草稿正在提交，提交结束前不能删除。' : '2 public drafts are being submitted; delete after they finish.')
  expect(sources.querySelector('[data-drafts-unknown]')!.textContent).toBe(locale === 'zh-CN'
    ? '3 份公开草稿提交结果未知，公开项目可能已收到正文，FULI 无法撤回；删除只清本机副本。'
    : '3 public drafts have an unknown submission result; the public project may already have the text and FULI cannot retract it. Deleting clears only the local copy.')
  expect(disabled()).toBe(true); await submit(); expect(postJson).toHaveBeenCalledTimes(1)
  expect(sources.querySelector('a')).toBeNull()
  wrapper.unmount()
  postJson.mockResolvedValueOnce(preview({ drafts: { pending: 0, submitted: 0, submitting: 0, unknown: 1 } }))
    .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
  await open(); expect(disabled()).toBe(false); await submit()
  expect(postJson.mock.calls.at(-1)?.[0]).toContain('/hard-delete')
})

it('keeps source deletion controls absent for a peek with no source identity', async () => {
  const view: SessionRecordsView = { session: { sourceApplication: 'codex', sessionId: 'session', url: '', deletionTargetId: 'target' }, entries: [], total: 0, stretches: [], truncated: false }
  await peek(view, { ...entry, detail: {} })
  expect(document.body.querySelector('[data-source-delete-controls]')).toBeNull()
})


it('distinguishes several source actions by the saved turn and time', async () => {
  const turn = { number: 7, key: 'turn:one', kind: 'turn', type: 'turn', group: 'transcript', summary: '', project: null, link: '', detail: {}, at: '2026-10-23T08:30:00Z' } as SessionEntry
  const second = { ...turn, key: 'turn:two', number: 8, at: '2026-10-23T09:45:00Z' }
  const view: SessionRecordsView = { session: { sourceApplication: 'codex', sessionId: 'session', deletionTargetId: 'opaque', url: '' }, entries: [turn, second], total: 2, stretches: [], truncated: false }
  await peek(view, { ...entry, detail: { sources: [{ episode_id: 'first', turn: turn.key }, { episode_id: 'second', turn: second.key }] } })
  const buttons = [...document.body.querySelectorAll('[data-source-delete-open="episode"]')]
  expect(buttons).toHaveLength(2)
  expect(buttons[0]!.textContent).toMatch(/删除这段来源：#7 · .+…/)
  expect(buttons[1]!.textContent).toMatch(/删除这段来源：#8 · .+…/)
  expect(buttons[0]!.textContent).not.toBe(buttons[1]!.textContent)
  expect(document.body.querySelector('[data-source-delete-open="session"]')).toBeNull()
})


it.each(['zh-CN', 'en-US'] as const)('rechecks public submission results through a fresh preview before confirming in %s', async locale => {
  setLocale(locale, { persist: false })
  let finish!: (value: SourceDeletePreview) => void
  postJson.mockResolvedValueOnce(preview({ drafts: { pending: 0, submitted: 0, submitting: 0, unknown: 1 } }))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
  await open();  expect(disabled()).toBe(false)
  const recheck = dialog().querySelector<HTMLButtonElement>('[data-drafts-recheck] button')!
  expect(recheck.textContent).toBe(locale === 'zh-CN' ? '重新确认提交结果' : 'Recheck submission result')
  recheck.click(); await flushPromises()
  expect(disabled()).toBe(true)
  expect(dialog().querySelector('[data-drafts-recheck]')!.textContent).toContain(locale === 'zh-CN' ? '正在重新确认公开草稿提交结果' : 'Rechecking public draft submission results')
  expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete/preview', { personalSpaceId: 'space', include: [], exclude: [] }])
  finish(preview({ preview_id: 'reconciled-digest', drafts: { pending: 0, submitted: 1, submitting: 0, unknown: 0 } })); await flushPromises()
  expect(dialog().querySelector('[data-drafts-recheck]')).toBeNull()
  expect(disabled()).toBe(false)
  await submit()
  expect(postJson.mock.calls[2]?.[1].previewId).toBe('reconciled-digest')
})


it('repreviews a submission that starts after the shown preview instead of leaving confirmation enabled', async () => {
  postJson.mockResolvedValueOnce(preview({ drafts: { pending: 1, submitted: 0, submitting: 0, unknown: 0 } }))
    .mockRejectedValueOnce(new ApiError('submission started', 409, '{"code":"hard_delete_draft_submitting"}'))
    .mockResolvedValueOnce(preview({ preview_id: 'now-submitting', drafts: { pending: 0, submitted: 0, submitting: 1, unknown: 0 } }))
  await open(); await submit()
  expect(postJson).toHaveBeenCalledTimes(3)
  expect(disabled()).toBe(true)
  expect(dialog().querySelector('[data-drafts-submitting]')!.textContent).toContain('1 份公开草稿正在提交')
  expect(dialog().querySelector('[data-drafts-recheck]')).not.toBeNull()
})


describe('source working-memory deletion preview', () => {
  const scope = { agent_id: 'synthetic-agent', agent_name: 'Synthetic Guide', personal_project_id: 'synthetic-project', revisions: [2, 3], current: false, current_revision: 5 }
  const later = { ...scope, key: 'memory:provider-head', from_revision: 2, revisions: [4, 5], selected: false }
  it('shows exact source snapshots and no-fallback warning without fetching memory bodies', async () => {
    postJson.mockResolvedValue(preview({ agent_memory: { scrubbed: [{ ...scope, current: true, current_revision: 3 }], later: [later] } }))
    await open()
    const block = dialog().querySelector('[data-source-memory]')!
    expect(block.textContent).toContain('2 条 Agent 工作记忆快照')
    expect(block.textContent).toContain('含当前版本')
    expect(block.textContent).toContain('Synthetic Guide')
    expect(block.textContent).toContain('不会回退到旧版本')
    expect(block.textContent).toContain('仍在运行的会话')
    expect(getJson).not.toHaveBeenCalled()
    expect(dialog().querySelector('[data-source-memory-later] [role="checkbox"]')!.getAttribute('aria-checked')).toBe('false')
  })
  it('removes a later group from include without excluding any exact-source snapshot', async () => {
    postJson.mockResolvedValueOnce(preview({ include: [later.key], agent_memory: { scrubbed: [scope], later: [{ ...later, selected: true }] } }))
      .mockResolvedValueOnce(preview({ preview_id: 'kept-memory', agent_memory: { scrubbed: [scope], later: [later] } }))
    await open();    dialog().querySelector<HTMLButtonElement>('[data-source-memory-later] [role="checkbox"]')!.click()
    await flushPromises()
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', include: [], exclude: [] })
    expect(disabled()).toBe(false)
    expect(dialog().querySelector('[data-source-memory] [role="checkbox"]')).toBeNull()
  })
  it('describes session memory and the live-context limitation in English', async () => {
    setLocale('en-US', { persist: false })
    const session: SourceDeleteTarget = { item_kind: 'session', item_id: 'opaque-session', sourceApplication: 'codex', sessionId: 'synthetic-session' }
    postJson.mockResolvedValue(preview({ ...session, agent_memory: { scrubbed: [{ ...scope, current: true, current_revision: 3 }], later: [later] } }))
    await open(session)
    const block = dialog().querySelector('[data-source-memory]')!
    expect(block.textContent).toContain('2 Agent working-memory snapshots written in this session lose their text')
    expect(block.textContent).toContain('including the current version')
    expect(block.textContent).toContain('Memory does not fall back to an older version.')
    expect(block.textContent).toContain('Still-running sessions may hold deleted text')
    expect(dialog().querySelector('[data-source-memory-later]')!.textContent).toContain('kept by default')
  })
  it('repreviews only the Provider-owned memory group key and binds confirmation to the new digest', async () => {
    postJson.mockResolvedValueOnce(preview({ agent_memory: { scrubbed: [scope], later: [later] } }))
      .mockResolvedValueOnce(preview({ preview_id: 'memory-digest', include: [later.key], agent_memory: { scrubbed: [scope], later: [{ ...later, selected: true }] } }))
      .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
    await open();    dialog().querySelector<HTMLButtonElement>('[data-source-memory-later] [role="checkbox"]')!.click()
    await flushPromises()
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', include: [later.key], exclude: [] })
    expect(disabled()).toBe(false)
    await submit()
    expect(postJson.mock.calls[2]?.[1]).toEqual({ personalSpaceId: 'space', include: [later.key], exclude: [], previewId: 'memory-digest', confirmation: '删除' })
  })
})

it.each(['zh-CN', 'en-US'] as const)('shows memory names without opaque IDs or hover titles in %s', async locale => {
  setLocale(locale, { persist: false })
  const scope = { agent_id: 'opaque-agent-secret-identifier', personal_project_id: 'opaque-project-secret-identifier', revisions: [2], current_revision: 3, current: false }
  postJson.mockResolvedValue(preview({ agent_memory: { scrubbed: [{ ...scope, agent_name: 'Synthetic Guide', project_name: 'Named project' }], later: [{ ...scope, key: 'memory:opaque-head', from_revision: 2, revisions: [3], selected: false }] } }))
  await open()
  const first = dialog().querySelector('[data-source-memory]')!
  const later = dialog().querySelector('[data-source-memory-later]')!
  expect(first.textContent).toContain('Synthetic Guide · Named project')
  expect(later.textContent).toContain(locale === 'zh-CN' ? '未命名 Agent' : 'Unnamed Agent')
  for (const area of [first, later]) {
    expect(area.textContent).not.toContain('opaque-')
    expect(area.textContent).not.toContain('…')
    expect(area.querySelector('[title]')).toBeNull()
  }
})

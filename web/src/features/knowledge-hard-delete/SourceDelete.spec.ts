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
async function type(value: string) {
  const input = dialog().querySelector<HTMLInputElement>('[data-hard-delete-confirm]')!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}
async function choose(key: string) {
  dialog().querySelector<HTMLButtonElement>(`[data-source-row="${key}"] [role="checkbox"]`)!.click()
  await flushPromises()
}
async function submit() { dialog().querySelector('form')!.dispatchEvent(new Event('submit')); await flushPromises() }
const disabled = () => dialog().querySelector<HTMLButtonElement>('[data-hard-delete-submit]')!.disabled

beforeEach(() => { vi.resetAllMocks(); document.body.innerHTML = '' })
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount() })

describe('source deletion uses the authoritative two-layer preview', () => {
  it('repreviews canonical row keys, clears confirmation, and sends only the latest digest and selection', async () => {
    let finish!: (value: SourceDeletePreview) => void
    postJson.mockResolvedValueOnce(preview()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ outcome: 'complete', ...target, counts })
    await open()
    expect(dialog().textContent).toContain('Older version')
    expect(dialog().querySelectorAll('[data-source-layer]')).toHaveLength(2)
    expect(dialog().querySelector('[data-source-basis-changed]')).not.toBeNull()
    await type('delete')
    expect(disabled()).toBe(false)
    await choose('entity:other')
    expect(disabled()).toBe(true)
    expect(dialog().querySelector<HTMLInputElement>('[data-hard-delete-confirm]')!.value).toBe('')
    expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete/preview',
      { personalSpaceId: 'space', include: ['entity:other'], exclude: [] }])
    await submit()
    expect(postJson).toHaveBeenCalledTimes(2)
    finish(preview({ preview_id: 'digest-2', include: ['entity:other'] }))
    await flushPromises()
    expect(disabled()).toBe(true)
    await type('delete'); await submit()
    expect(postJson.mock.calls[2]).toEqual(['/api/knowledge/episode/source%2Fopaque/hard-delete',
      { personalSpaceId: 'space', include: ['entity:other'], exclude: [], previewId: 'digest-2', confirmation: 'delete' }])
    expect(document.body.textContent).not.toContain('SYNTHETIC SOURCE BODY')
  })

  it('a rejected selection never permits confirming the previous preview', async () => {
    postJson.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new ApiError('invalid selection', 400, '{"code":"invalid_selection"}'))
    await open(); await type('delete'); await choose('entity:head')
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', include: [], exclude: ['entity:head'] })
    await type('delete'); await submit()
    expect(disabled()).toBe(true)
    expect(postJson).toHaveBeenCalledTimes(2)
    expect(dialog().querySelector('[data-hard-delete-error]')).not.toBeNull()
  })

  it('a graph change requires a new preview and another typed confirmation', async () => {
    postJson.mockResolvedValueOnce(preview()).mockRejectedValueOnce(new ApiError('changed', 409, '{"code":"hard_delete_preview_stale"}'))
      .mockResolvedValueOnce(preview({ preview_id: 'changed-digest' }))
    await open(); await type('delete'); await submit()
    expect(postJson).toHaveBeenCalledTimes(3)
    expect(disabled()).toBe(true)
    expect(dialog().querySelector<HTMLInputElement>('[data-hard-delete-confirm]')!.value).toBe('')
  })

  it('explains attached relationships and leaves endpoint-first retention possible', async () => {
    const value = preview()
    value.default_items.push({ ...value.default_items[0]!, key: 'relationship:edge', reason: 'attached_relationship' })
    postJson.mockResolvedValue(value)
    await open()
    expect(dialog().querySelector<HTMLButtonElement>('[data-source-row="relationship:edge"] [role="checkbox"]')!.disabled).toBe(false)
    expect(dialog().querySelector<HTMLButtonElement>('[data-source-row="entity:head"] [role="checkbox"]')!.disabled).toBe(false)
  })

  it('uses the supplied session target and tuple, but status sends only personalSpaceId', async () => {
    const session: SourceDeleteTarget = { item_kind: 'session', item_id: 'opaque-provider-target', sourceApplication: 'codex', sessionId: 'synthetic-session' }
    postJson.mockResolvedValueOnce(preview({ ...session, source_application: 'codex', fuli_session_id: 'synthetic-session' }))
      .mockResolvedValueOnce({ outcome: 'complete', ...session, counts }).mockResolvedValueOnce({ outcome: 'complete' })
    await open(session); await type('delete'); await submit()
    expect(postJson.mock.calls[0]).toEqual(['/api/knowledge/session/opaque-provider-target/hard-delete/preview',
      { personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'synthetic-session', include: [], exclude: [] }])
    expect(postJson.mock.calls[1]?.[1]).toEqual({ personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'synthetic-session',
      include: [], exclude: [], previewId: 'digest-1', confirmation: 'delete' })
    await hardDeleteStatus('space', session)
    expect(postJson.mock.calls[2]).toEqual(['/api/knowledge/session/opaque-provider-target/hard-delete/status', { personalSpaceId: 'space' }])
  })
})

const entry: SessionEntry = { number: 1, key: 'entity:head', kind: 'entity', type: 'Note', group: 'knowledge',
  summary: 'SYNTHETIC', project: null, link: '', detail: { sources: [{ episode_id: 'actual-episode', turn: 'turn:one' }] } }
async function peek(view: SessionRecordsView) {
  const host = defineComponent({ components: { Dialog, DialogContent, SessionRecordPeek }, setup: () => ({ view, entry }),
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
  expect(document.body.querySelector('[data-source-delete-open="session"]')).not.toBeNull()
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
  await type('delete'); await submit()
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
  await wrapper.get('[data-source-delete-open="session"]').trigger('click'); await flushPromises()
  await type('delete'); await submit()
  expect(wrapper.find('[data-source-deleted-page]').exists()).toBe(true)
  expect(wrapper.find('[data-session-total]').exists()).toBe(false)
  expect(postJson.mock.calls[1]).toEqual(['/api/knowledge/session/opaque-session/hard-delete', {
    personalSpaceId: 'space', sourceApplication: 'codex', sessionId: 'session-one', include: [], exclude: [], previewId: 'digest-1', confirmation: 'delete',
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
    await wrapper.get('[data-hard-delete-toggle] button').trigger('click')
    await wrapper.get('[data-hard-delete-open]').trigger('click'); await flushPromises()
  }
  await type('delete'); await submit()
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

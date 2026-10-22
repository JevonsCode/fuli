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
import { setLocale } from '@/i18n'
import { LOADING_VISIBILITY_DELAY_MS, MINIMUM_LOADING_DISPLAY_MS } from '@/composables/useMinimumLoadingDisplay'
import { useConsoleStore } from '@/stores/console'
import type { GovernancePreview, TagDetail, TagEntry } from './model'
import TagVocabularyPage from './TagVocabularyPage.vue'

// rec#11 D-07 part 2: the vocabulary page, its review queue and the person's
// governance dialogs. Synthetic tags only; the API client is mocked.
const DIGEST = 'd'.repeat(64)

function tag(id: string, name: string, overrides: Partial<TagEntry> = {}): TagEntry {
  return { id, name, namespace: 'personal', status: 'active', project_id: null, description: null, aliases: [],
    provisional_aliases: [], proposed_aliases: [], linked_items: 2, parents: [], related: [], merged_into: null,
    needs_review: false, source: { kind: 'human', application: null, reason: 'synthetic' }, version: 1,
    created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z', ...overrides }
}

const outdoor = tag('t1', '户外学习', { namespace: 'project', project_id: 'nature', status: 'provisional', needs_review: true,
  aliases: ['野外课'], provisional_aliases: ['野外课'], source: { kind: 'agent', application: 'codex', reason: 'new' } })
const nature = tag('t2', '自然教育', { parents: [{ id: 't3', name: '教学方法', namespace: 'personal', status: 'active' }] })
const vocabulary = (tags: TagEntry[], review = 1) => ({ tags, total: tags.length, next_offset: null, review_count: review })

function detail(entry: TagEntry): TagDetail {
  return { tag: entry, children: [], merged_from: [], unfinished_restores: [], links_truncated: false,
    links: [{ item_kind: 'entity', item_id: 'i1', title: 'Bird walk', attached_at: null, moved_from: null }],
    history: [{ action: 'create', actor_kind: 'agent', reason: 'new', created_at: '2026-10-22T00:00:00Z', version: 1,
      operation_id: null, alias: null, relation: null, other: null, undone: false, undoable: false }] }
}

function mergePreview(overrides: Partial<GovernancePreview> = {}): GovernancePreview {
  return { change: 'merge', tag: outdoor, other: nature, status_after: 'merged', new_tag_name: null, revives: false,
    links_moved: 1, links_already_on_target: 0, links_remaining: null, aliases: [], aliases_dropped: [],
    relations_moved: 0, relations_dropped: [], undo: null,
    blocked: null, digest: DIGEST, ...overrides }
}

function respond(read: (url: string) => unknown) {
  getJson.mockImplementation(async (url: string) => read(url))
}

async function open(path = '/tags') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [{ project_id: 'nature', personal_space_id: 'space', profile: { name: '自然课' } }], projects: [],
    subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tags', component: TagVocabularyPage }] })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(TagVocabularyPage, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, router }
}

const dialog = () => document.querySelector<HTMLElement>('[data-tag-dialog]')
const click = async (selector: string) => {
  document.querySelector<HTMLElement>(selector)!.click()
  await flushPromises()
}

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  getJson.mockReset()
  postJson.mockReset()
  document.body.innerHTML = ''
})

describe('TagVocabularyPage', () => {
  it('lists every namespace with status, aliases, relations and linked counts', async () => {
    const short = tag('t4', '短句', { needs_review: true, proposed_aliases: ['简短句子'] })
    respond(url => url.startsWith('/api/knowledge-tags/vocabulary') ? vocabulary([outdoor, nature, short]) : null)
    const { wrapper } = await open()
    expect(getJson).toHaveBeenCalledWith('/api/knowledge-tags/vocabulary?personalSpaceId=space&limit=100')
    expect(wrapper.findAll('[data-tag-group] h2').map(heading => heading.text())).toEqual(['项目「自然课」', '个人词表'])
    const card = wrapper.get('[data-tag-card="t1"]')
    expect(card.text()).toContain('待审核')
    expect(card.text()).toContain('野外课')
    expect(card.text()).toContain('2 条知识')
    expect(card.text()).toContain('Agent 建立')
    expect(wrapper.get('[data-tag-card="t2"]').text()).toContain('上位教学方法')
    expect(wrapper.find('[data-tag-card="t2"] [data-tag-review-reason]').exists()).toBe(false)
    // An active tag in the queue says why: an alias waits for the person.
    expect(wrapper.get('[data-tag-card="t4"] [data-tag-review-reason]').text()).toBe('有待你确认的别名')
    expect(wrapper.get('[data-tag-review-count]').text()).toBe('1')
    expect(wrapper.find('h1').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the review queue from the review filter, and an empty queue says what lands there', async () => {
    respond(url => url.includes('status=review') ? vocabulary([], 0) : vocabulary([outdoor]))
    const { wrapper } = await open()
    await wrapper.get('[data-tag-tab="review"]').trigger('mousedown')
    await wrapper.get('[data-tag-tab="review"]').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenLastCalledWith('/api/knowledge-tags/vocabulary?personalSpaceId=space&limit=100&status=review')
    expect(wrapper.get('[data-tag-empty]').text()).toContain('Agent 新建的标签和提议的别名会出现在这里')
    wrapper.unmount()
  })

  it('shows one loading state, labelled with what it reads, while the vocabulary loads', async () => {
    let resolve: (value: unknown) => void = () => {}
    getJson.mockImplementation(() => new Promise(done => { resolve = done }))
    const { wrapper } = await open()
    // The loader shows after the shared visibility delay, so a fast read never flashes it.
    await new Promise(done => setTimeout(done, LOADING_VISIBILITY_DELAY_MS + 10))
    expect(wrapper.findAll('[role="status"]').map(status => status.attributes('aria-label'))).toEqual(['正在读取标签词表'])
    resolve(vocabulary([nature]))
    await new Promise(done => setTimeout(done, MINIMUM_LOADING_DISPLAY_MS + 10))
    await flushPromises()
    expect(wrapper.find('[data-tag-card="t2"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('opens a tag, lifts its card and approves it with the previewed digest', async () => {
    respond(url => url.startsWith('/api/knowledge-tags/detail') ? detail(outdoor) : vocabulary([outdoor]))
    postJson.mockImplementation(async (url: string) => url.endsWith('/governance/preview')
      ? mergePreview({ change: 'approve', other: null, status_after: 'active', links_moved: null })
      : { operation_id: 'op-1' })
    const { wrapper } = await open()
    await wrapper.get('[data-tag-card="t1"] [data-tag-open]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-tag-card="t1"]').classes()).toContain('shadow-md')
    expect(dialog()?.textContent).toContain('Bird walk')
    await click('[data-tag-action="approve"]')
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags/governance/preview',
      { personalSpaceId: 'space', change: 'approve', tagId: 't1' })
    expect(dialog()?.querySelector('[data-tag-preview]')?.textContent).toContain('「户外学习」变为已启用。')
    await click('[data-tag-governance-confirm]')
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags/governance', { personalSpaceId: 'space', change: 'approve',
      tagId: 't1', previewDigest: DIGEST, reason: '在标签词表里整理' })
    expect(dialog()?.querySelector('[data-tag-done]')?.textContent).toBe('已完成。')
    wrapper.unmount()
  })

  it('opens an Agent link on the change it asked for and previews again when the vocabulary moved', async () => {
    respond(url => url.startsWith('/api/knowledge-tags/detail') ? detail(outdoor) : vocabulary([outdoor, nature]))
    let previews = 0
    postJson.mockImplementation(async (url: string) => {
      if (url.endsWith('/governance/preview')) {
        previews += 1
        return mergePreview(previews > 1 ? { links_moved: 2, digest: 'e'.repeat(64) } : {})
      }
      throw new ApiError('changed', 409, JSON.stringify({ error: 'changed', code: 'preview_stale' }))
    })
    const { wrapper } = await open('/tags?tag=t1&change=merge&into=t2')
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags/governance/preview',
      { personalSpaceId: 'space', change: 'merge', tagId: 't1', intoTagId: 't2' })
    // The preselected target stands out on the selected surface (D-03 #8, D-23).
    const selected = dialog()?.querySelector('[data-tag-choice][aria-selected="true"]')
    expect(selected?.getAttribute('data-tag-choice')).toBe('t2')
    expect(selected?.classList).toContain('bg-accent')
    expect(dialog()?.querySelector('[data-tag-choice="t1"]'), 'a tag never merges into itself').toBeNull()
    const preview = dialog()?.querySelector('[data-tag-preview]')?.textContent ?? ''
    expect(preview).toContain('「户外学习」合并到「自然教育」')
    expect(preview).toContain('1 条知识改贴「自然教育」')
    await click('[data-tag-governance-confirm]')
    expect(dialog()?.querySelector('[data-tag-governance-notice]')?.textContent).toContain('词表在你预览之后变了')
    expect(dialog()?.querySelector('[data-tag-preview]')?.textContent).toContain('2 条知识改贴「自然教育」')
    expect(postJson.mock.calls.filter(([url]) => url === '/api/knowledge-tags/governance')).toHaveLength(1)
    wrapper.unmount()
  })

  it('follows the URL: another change or target on the same tag starts afresh, Back and Forward move between them', async () => {
    const third = tag('t3', '野外教学')
    respond(url => url.startsWith('/api/knowledge-tags/detail') ? detail(outdoor) : vocabulary([outdoor, nature, third]))
    postJson.mockImplementation(async (_url: string, body: { change: string; intoTagId?: string }) => mergePreview({
      change: body.change as GovernancePreview['change'],
      other: body.intoTagId === 't3' ? third : body.intoTagId ? nature : null }))
    const { wrapper, router } = await open('/tags?tag=t1&change=merge&into=t2')
    const lastPreview = () => postJson.mock.calls.filter(([url]) => url.endsWith('/governance/preview')).at(-1)?.[1]
    const panel = () => dialog()?.querySelector('[data-tag-governance]')?.getAttribute('data-tag-governance')
    expect(lastPreview()).toMatchObject({ change: 'merge', intoTagId: 't2' })
    await router.push('/tags?tag=t1&change=merge&into=t3')
    await flushPromises()
    expect(lastPreview()).toMatchObject({ change: 'merge', intoTagId: 't3' })
    expect(dialog()?.querySelector('[data-tag-choice][aria-selected="true"]')?.getAttribute('data-tag-choice')).toBe('t3')
    expect(dialog()?.querySelector('[data-tag-preview]')?.textContent).toContain('「野外教学」')
    await router.push('/tags?tag=t1&change=retire')
    await flushPromises()
    expect([panel(), lastPreview()?.change]).toEqual(['retire', 'retire'])
    router.back()
    await flushPromises()
    await new Promise(done => setTimeout(done, 20))
    await flushPromises()
    expect([panel(), lastPreview()]).toEqual(['merge', expect.objectContaining({ intoTagId: 't3' })])
    router.forward()
    await flushPromises()
    await new Promise(done => setTimeout(done, 20))
    await flushPromises()
    expect(panel()).toBe('retire')
    await router.push('/tags')
    await flushPromises()
    expect(dialog()).toBeNull()
    // Opening a card puts the tag in the URL, so Back closes it again.
    await wrapper.get('[data-tag-card="t2"] [data-tag-open]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ tag: 't2' })
    router.back()
    await flushPromises()
    await new Promise(done => setTimeout(done, 20))
    await flushPromises()
    expect(dialog()).toBeNull()
    wrapper.unmount()
  })

  it('restores a mistaken merge from the merge record, in batches the preview labels', async () => {
    const merged = tag('t5', '野外教学', { status: 'merged', merged_into: nature })
    respond(url => url.startsWith('/api/knowledge-tags/detail')
      ? { ...detail(nature), merged_from: [merged], links_truncated: true } : vocabulary([nature, merged]))
    postJson.mockImplementation(async () => mergePreview({ change: 'split', tag: nature, other: merged, revives: true,
      new_tag_name: '野外教学', links_moved: 500, links_remaining: 3 }))
    const { wrapper } = await open('/tags?tag=t2')
    await click('[data-tag-action="split"]')
    await click('[data-tag-restore="t5"]')
    await new Promise(done => setTimeout(done, 350))
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge-tags/governance/preview', { personalSpaceId: 'space',
      change: 'split', tagId: 't2', split: { restoreTagId: 't5', aliases: [] } })
    expect(dialog()?.querySelector('[data-tag-split-restoring]')?.textContent).toContain('「野外教学」当时带来的全部知识')
    expect(dialog()?.querySelector('[data-tag-split-link]')).toBeNull()
    const lines = dialog()?.querySelector('[data-tag-preview]')?.textContent ?? ''
    expect(lines).toContain('500 条知识移回「野外教学」')
    expect(lines).toContain('还剩 3 条')
    wrapper.unmount()
  })

  it('offers to continue an unfinished split-back until it is done', async () => {
    const back = tag('t5', '野外教学')
    respond(url => url.startsWith('/api/knowledge-tags/detail')
      ? { ...detail(nature), unfinished_restores: [{ tag: back, remaining: 1 }] } : vocabulary([nature, back]))
    postJson.mockImplementation(async () => mergePreview({ change: 'split', tag: nature, other: back, revives: false,
      new_tag_name: '野外教学', links_moved: 1, links_remaining: 0 }))
    const { wrapper } = await open('/tags?tag=t2')
    expect(dialog()?.querySelector('[data-tag-unfinished-restores] p')?.textContent?.trim())
      .toBe('上次把「野外教学」拆出去还没做完：还有 1 条知识留在这个标签上。')
    const entry = dialog()?.querySelector('[data-tag-continue-restore="t5"]')
    expect(entry?.textContent?.trim()).toBe('继续恢复「野外教学」，剩余 1 条')
    await click('[data-tag-continue-restore="t5"]')
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge-tags/governance/preview', { personalSpaceId: 'space',
      change: 'split', tagId: 't2', split: { restoreTagId: 't5', aliases: [] } })
    expect(dialog()?.querySelector('[data-tag-split-restoring]')).not.toBeNull()
    wrapper.unmount()
  })

  it('splits chosen aliases and links and shows the preview the Provider refused', async () => {
    const source = tag('t2', '自然教育', { aliases: ['野外课', 'field class'] })
    respond(url => url.startsWith('/api/knowledge-tags/detail') ? detail(source) : vocabulary([source]))
    postJson.mockImplementation(async (_url: string, body: { split?: { name: string } }) => mergePreview({
      change: 'split', other: null, new_tag_name: body.split?.name ?? null,
      blocked: body.split?.name === '自然教育' ? { code: 'name_in_use', message: '另一个标签已经用了这个名字' } : null }))
    const { wrapper } = await open()
    await wrapper.get('[data-tag-card="t2"] [data-tag-open]').trigger('click')
    await flushPromises()
    await click('[data-tag-action="split"]')
    const name = dialog()!.querySelector<HTMLInputElement>('[data-tag-split-name]')!
    name.value = '自然教育'
    name.dispatchEvent(new Event('input'))
    await new Promise(done => setTimeout(done, 350))
    await flushPromises()
    expect(dialog()?.querySelector('[data-tag-preview-blocked]')?.textContent).toContain('另一个标签已经用了这个名字')
    expect(dialog()?.querySelector<HTMLButtonElement>('[data-tag-governance-confirm]')?.disabled).toBe(true)
    name.value = '野外教学'
    name.dispatchEvent(new Event('input'))
    await click('[data-tag-split-alias="野外课"]')
    await click('[data-tag-split-link="i1"]')
    await new Promise(done => setTimeout(done, 350))
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge-tags/governance/preview', { personalSpaceId: 'space',
      change: 'split', tagId: 't2', split: { name: '野外教学', description: null, aliases: ['野外课'],
        links: [{ itemKind: 'entity', itemId: 'i1' }] } })
    expect(dialog()?.querySelector<HTMLButtonElement>('[data-tag-governance-confirm]')?.disabled).toBe(false)
    wrapper.unmount()
  })
})

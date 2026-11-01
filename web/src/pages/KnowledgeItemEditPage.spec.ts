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
import { currentLocale } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
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
    { path: '/organize', component: { template: '<div />' } }, { path: '/preferences', component: { template: '<div />' } },
    { path: '/knowledge/:scope/:spaceId/:projectId/:mode/:itemKind/:itemId', component: { template: '<div />' } }] })
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
    expect(getJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1?personalSpaceId=space', expect.objectContaining({ schema: expect.anything() }))
    // D-20: the content equals the H1 (the item title), so the card does not repeat it.
    expect(wrapper.find('[data-item-content]').exists()).toBe(false)
    expect(wrapper.get('[data-item-summary]').attributes('aria-label')).toBe('Prefer short status lines')
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
      expectedVersion: 4, reason: 'Applies everywhere', scope: 'global', projectIds: [] }, expect.objectContaining({ schema: expect.anything() }))
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
      expectedVersion: 4, name: 'Status lines stay short' }), expect.objectContaining({ schema: expect.anything() }))
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

  it('rec#11 D-22.2: a project that already holds a match links to the item where 加入项目 decides', async () => {
    const wrapper = await open(view({ profile_aspect: null, category: 'fact', type: 'ProjectFact', confirmation_status: 'confirmed',
      scope: { kind: 'projects', projects: [{ id: 'alpha', name: 'Alpha' }], status: 'set' } }))
    expect(wrapper.get('[data-scope-other-knowledge]').text()).toContain('一个或多个项目')
    postJson.mockRejectedValue(new ApiError('match', 409, JSON.stringify({ error: 'match', code: 'project_has_match' })))
    await wrapper.get('#scope-reason').setValue('Also for beta')
    await wrapper.get('[data-scope-editor] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-scope-message]').text()).toContain('不替你决定')
    expect(wrapper.get('[data-scope-join-project]').attributes('href'))
      .toBe('/knowledge/personal/space/alpha/directory/entity/item-1')
    wrapper.unmount()
  })

  it('rec#5 C8-1: marks the item outdated with a reason, and history keeps only its record', async () => {
    const wrapper = await open()
    patchJson.mockResolvedValue({ id: 'r2', action: 'mark_outdated', dependents_outdated: 1 })
    await wrapper.get('#outdated-reason').setValue('No longer true')
    await wrapper.get('[data-mark-outdated] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', { personalSpaceId: 'space', action: 'mark_outdated',
      reason: 'No longer true', expectedVersion: 4 }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.get('[data-content-message]').text()).toBe('已标记过时 1 条依据它推出的结论已标为“依据已过时”。')
    wrapper.unmount()
    const historical = await open(view({ status: 'inactive', invalid_at: '2026-10-21T02:00:00Z' }))
    expect(historical.find('[data-scope-editor]').exists()).toBe(false)
    expect(historical.find('[data-content-editor]').exists()).toBe(false)
    expect(historical.find('[data-mark-outdated]').exists()).toBe(false)
    expect(historical.get('[data-item-status]').text()).toBe('已停用')
    expect(historical.find('[data-item-historical]').exists()).toBe(true)
    expect(historical.find('[data-item-history]').exists()).toBe(true)
    historical.unmount()
  })

  it('rec#5 C7-1: an edit is saved as a new version and the page moves to it', async () => {
    const wrapper = await open()
    patchJson.mockResolvedValue({ id: 'r3', action: 'update', version_item_id: 'item-2' })
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/project-agents') ? []
      : url.includes('item-2') ? view({ item_id: 'item-2', version: 0, content: 'Status lines stay short',
        title: 'Status lines stay short', confirmation_status: 'confirmed' }) : view())
    await wrapper.get('#item-content').setValue('Status lines stay short')
    await wrapper.get('#content-reason').setValue('Clearer')
    await wrapper.get('[data-content-editor] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', { personalSpaceId: 'space', action: 'update',
      reason: 'Clearer', expectedVersion: 4, name: 'Status lines stay short', summary: 'Status lines stay short' }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.vm.$route.fullPath).toBe('/knowledge/item/space/entity/item-2')
    expect(wrapper.get('[data-item-summary]').attributes('aria-label')).toBe('Status lines stay short')
    expect(wrapper.get('[data-edit-notice]').text()).toBe('已保存为新版本')
    wrapper.unmount()
  })

  it('rec#5 C7-2: an old link shows the replaced version as history and points at the current one', async () => {
    const wrapper = await open(view({ status: 'superseded', invalid_at: '2026-10-21T02:00:00Z', current_item_id: 'item-2' }))
    expect(wrapper.get('[data-item-status]').text()).toBe('已被替代')
    expect(wrapper.get('[data-item-historical]').text()).toContain('当前回答只用最新版本')
    expect(wrapper.get('[data-current-version]').attributes('href')).toBe('/knowledge/item/space/entity/item-2')
    expect(wrapper.find('[data-content-editor]').exists()).toBe(false)
    expect(wrapper.find('[data-scope-editor]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('rec#5 C7-3: history lists every version with who wrote it, and one opens in a quick look by URL', async () => {
    const versions = [
      { item_kind: 'entity', item_id: 'item-1', content: 'Prefer short status lines', status: 'current',
        confirmation_status: 'confirmed', content_source: 'user_explicit', changed_by: 'user', reason: 'My words',
        created_at: '2026-10-21T02:00:00Z' },
      { item_kind: 'entity', item_id: 'item-0', content: 'Prefer long status updates', status: 'superseded',
        confirmation_status: 'agent_confirmed', content_source: 'agent_inferred', changed_by: 'agent',
        created_at: '2026-10-20T02:00:00Z', invalid_at: '2026-10-21T02:00:00Z' }]
    const wrapper = await open(view({ versions, current_item_id: 'item-1', confirmation_status: 'confirmed' }))
    const rows = wrapper.findAll('[data-item-versions] li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('当前版本')
    // The same formatter in the runner's time zone, so the spec holds in any zone.
    const shown = formatDateTime('2026-10-21T02:00:00Z', currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
    expect(rows[0].get('[data-version-who]').text()).toBe(`${shown} · 我`)
    expect(rows[0].get('[data-version-evidence]').text()).toBe('你明确说的 · 你已确认')
    expect(rows[0].text()).toContain('原因：My words')
    expect(rows[0].find('[aria-current="true"]').exists()).toBe(true)
    expect(rows[1].text()).toContain('已被替代')
    expect(rows[1].get('[data-version-who]').text()).toContain('· Agent')
    expect(rows[1].get('[data-version-evidence]').text()).toBe('Agent 推断 · Agent 已确认')
    getJson.mockImplementation(async (url: string) => url.includes('item-0')
      ? view({ item_id: 'item-0', content: 'Prefer long status updates', status: 'superseded', content_source: 'agent_inferred',
        confirmation_status: 'agent_confirmed', invalid_at: '2026-10-21T02:00:00Z', current_item_id: 'item-1' }) : view())
    await rows[1].get('button').trigger('click')
    await flushPromises()
    expect(wrapper.vm.$route.query.item).toBe('space/entity%3Aitem-0')
    const peek = document.body.querySelector('[data-version-peek]')!
    expect(peek.textContent).toContain('Prefer long status updates')
    expect(peek.textContent).toContain('Agent 推断')
    expect(peek.querySelector('[data-version-open]')?.getAttribute('href')).toBe('/knowledge/item/space/entity/item-0')
    wrapper.unmount()
  })

  it('rec#5 C8-3: an outdated item is confirmed again only as a new version', async () => {
    const wrapper = await open(view({ status: 'outdated', invalid_at: '2026-10-21T02:00:00Z', current_item_id: null }))
    expect(wrapper.get('[data-item-historical]').text()).toContain('不再交付给 Agent')
    expect(wrapper.find('[data-mark-outdated]').exists()).toBe(false)
    expect(wrapper.get('[data-content-editor="reassert"]').text()).toContain('旧版本保留“已过时”的那段时间')
    patchJson.mockResolvedValue({ id: 'r4', action: 'update', version_item_id: 'item-3' })
    await wrapper.get('#content-reason').setValue('其实还是这样')
    await wrapper.get('[data-content-editor] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', expect.objectContaining({ action: 'update',
      name: 'Prefer short status lines', reason: '其实还是这样' }), expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.vm.$route.fullPath).toBe('/knowledge/item/space/entity/item-3')
    wrapper.unmount()
  })

  it('rec#5 C8-4: a conclusion names what it rests on and says when that went out of date', async () => {
    const wrapper = await open(view({ status: 'basis_outdated', invalid_at: '2026-10-21T02:00:00Z', category: 'fact',
      bases: [{ item_kind: 'entity', item_id: 'pref-1', content: 'Weekly reports in Word', status: 'outdated' }] }))
    expect(wrapper.get('[data-item-status]').text()).toBe('依据已过时')
    expect(wrapper.get('[data-item-historical]').text()).toContain('不再当成现行事实交付')
    const basis = wrapper.get('[data-item-bases] li')
    expect(basis.text()).toContain('已过时')
    expect(basis.get('a').attributes('href')).toBe('/knowledge/item/space/entity/pref-1')
    wrapper.unmount()
  })

  it('D-20: history reads as words people use, and one marker per pending choice', async () => {
    const versions = [
      { item_kind: 'entity', item_id: 'item-1', content: 'Prefer short status lines', status: 'current',
        confirmation_status: 'confirmed', content_source: 'user_explicit', changed_by: 'user', created_at: '2026-10-21T02:00:00Z',
        released_bases: ['pref-old'] },
      { item_kind: 'entity', item_id: 'item-0', content: 'Prefer long status updates', status: 'superseded',
        confirmation_status: 'agent_confirmed', content_source: 'agent_inferred', changed_by: 'agent', created_at: '2026-10-20T02:00:00Z' }]
    const wrapper = await open(view({ versions, evidence: [
      { episode_id: 'e1', source_kind: 'human_knowledge_edit', source_application: null, session_id: null, excerpt: 'x' },
      { episode_id: 'e2', source_kind: 'agent_knowledge_edit', source_application: 'codex', session_id: null, excerpt: 'y' }] }))
    const sources = wrapper.findAll('[data-item-sources] li')
    expect(sources[0].text()).toContain('控制台 · 你在控制台修改')
    expect(sources[1].text()).toContain('codex · Agent 修改')
    expect(wrapper.get('[data-item-versions] li [data-version-viewing]').text()).toBe('正在看')
    expect(wrapper.get('[data-released-bases]').text()).toBe('依据已过时，重新确认时解除 1 条')
    wrapper.unmount()
    const old = await open(view({ status: 'superseded', invalid_at: '2026-10-21T02:00:00Z', current_item_id: 'item-2',
      weight: { percent: 85, basis: { confirmation_status: 'agent_confirmed', confirmed_by_person: false, qualified_use_count: 7,
        distinct_task_count: 4, source_count: 2, negative_evidence_count: 0 } } }))
    expect(old.get('[data-item-weight]').text()).toBe('不再使用 · 失效前权重 85%')
    old.unmount()
  })

  it('D-20: the version quick look keeps a single close control', async () => {
    const versions = [{ item_kind: 'entity', item_id: 'item-0', content: 'Old', status: 'superseded', confirmation_status: 'pending' }]
    const wrapper = await open(view({ versions: [{ ...versions[0], item_id: 'item-1', status: 'current' }, ...versions] }))
    await wrapper.findAll('[data-item-versions] li')[1]!.get('button').trigger('click')
    await flushPromises()
    const peek = document.body.querySelector('[data-version-peek]')!
    expect(peek.querySelector('[data-peek-close]')).toBeNull()
    expect([...peek.querySelectorAll('button')].filter(button => button.textContent?.includes('关闭'))).toHaveLength(0)
    wrapper.unmount()
  })

  it('D-20.7: an edit of a basis asks what it means, defaults to a changed meaning, and sends the choice', async () => {
    const wrapper = await open(view({ dependent_count: 2 }))
    expect(wrapper.get('[data-basis-meaning]').text()).toContain('有 2 条结论依据它')
    expect(wrapper.get('[data-meaning-choice="changed"] [role="radio"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-basis-meaning]').text()).toContain('依据它的结论会先停止交付给 Agent，等你复核。')
    expect(wrapper.find('[data-settles-review]').exists()).toBe(false)
    patchJson.mockResolvedValue({ version_item_id: 'item-2', dependents_changed: 2 })
    await wrapper.get('#item-content').setValue('Status lines stay short')
    await wrapper.get('#content-reason').setValue('Clearer')
    await wrapper.get('[data-content-editor] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith('/api/knowledge/entity/item-1', expect.objectContaining({ basisMeaning: 'changed' }), expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.get('[data-edit-notice]').text()).toBe('已保存为新版本 2 条依据它的结论等你复核。')
    wrapper.unmount()
    const reworded = await open(view({ dependent_count: 1 }))
    await reworded.get('[data-meaning-choice="wording_only"] [role="radio"]').trigger('click')
    expect(reworded.get('[data-basis-meaning]').text()).toContain('依据它的结论照常交付，会提示你复核。')
    expect(reworded.get('[data-basis-meaning]').text()).not.toContain('先停止交付')
    await reworded.get('#item-content').setValue('Status lines stay brief')
    await reworded.get('#content-reason').setValue('Wording')
    await reworded.get('[data-content-editor] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenLastCalledWith('/api/knowledge/entity/item-1', expect.objectContaining({ basisMeaning: 'wording_only' }), expect.objectContaining({ schema: expect.anything() }))
    reworded.unmount()
    const alone = await open(view({ dependent_count: 0 }))
    expect(alone.find('[data-basis-meaning]').exists()).toBe(false)
    expect(alone.find('[data-item-dependents]').exists()).toBe(false)
    alone.unmount()
  })

  it('D-20.7: a conclusion whose basis changed waits for a review; 仍然成立 writes a new version', async () => {
    const wrapper = await open(view({ basis_review: 'changed', confirmation_status: 'confirmed',
      bases: [{ item_kind: 'entity', item_id: 'pref-2', content: 'Docs in AsciiDoc', status: 'current' }] }))
    expect(wrapper.get('[data-basis-review]').text()).toBe('依据已变，待复核')
    // Not delivered while it waits: no live weight bar (Fable UI check).
    expect(wrapper.get('[data-item-weight]').text()).toBe('暂不交付 · 复核后恢复 12%')
    expect(wrapper.find('[data-item-weight] [role="meter"], [data-item-weight] progress').exists()).toBe(false)
    expect(wrapper.get('[data-basis-review-card="changed"]').text()).toContain('复核前不交付给 Agent')
    // Editing it is a review too, and the form says so (dot round 4).
    expect(wrapper.get('[data-content-editor] [data-settles-review]').text())
      .toBe('这也会把「依据已变，待复核」标记为已复核。')
    patchJson.mockResolvedValue({ version_item_id: 'item-3' })
    await wrapper.get('#review-reason').setValue('Still true')
    await wrapper.get('[data-basis-review-card] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', { personalSpaceId: 'space', action: 'reaffirm',
      reason: 'Still true', expectedVersion: 4 }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.vm.$route.fullPath).toBe('/knowledge/item/space/entity/item-3')
    wrapper.unmount()
    const hinted = await open(view({ basis_review: 'reworded' }))
    expect(hinted.get('[data-basis-review]').text()).toBe('依据已更新，请复核')
    expect(hinted.find('[data-basis-review-card="reworded"]').exists()).toBe(true)
    hinted.unmount()
  })

  it('D-20.7: from a basis version record a person marks later that the meaning changed', async () => {
    const wrapper = await open(view({ status: 'superseded', invalid_at: '2026-10-21T02:00:00Z', current_item_id: 'item-2',
      dependent_count: 3 }))
    expect(wrapper.get('[data-item-dependents]').text()).toContain('有 3 条结论依据它')
    patchJson.mockResolvedValue({ dependents_changed: 3 })
    await wrapper.get('#meaning-reason').setValue('It did change the meaning')
    await wrapper.get('[data-item-dependents] form').trigger('submit')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/knowledge/entity/item-1', { personalSpaceId: 'space',
      action: 'mark_meaning_changed', reason: 'It did change the meaning', expectedVersion: 4 }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.get('[data-review-message]').text()).toBe('3 条结论等你复核。')
    wrapper.unmount()
  })

  it('removes a project tag of the second project of an item from that project, not the first', async () => {
    const wrapper = await open(view({ scope: { kind: 'projects', projects: [{ id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' }], status: 'set' },
    tags: [{ id: 'tb', name: 'beta-only', namespace: 'project', status: 'active', project_id: 'beta' }] }))
    postJson.mockResolvedValue({ outcome: 'detached' })
    await wrapper.get('[data-attached-tags] button').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags', { action: 'detach', personalSpaceId: 'space',
      personalProjectId: 'beta', tagId: 'tb', itemKind: 'entity', itemId: 'item-1' }, expect.objectContaining({ schema: expect.anything() }))
    wrapper.unmount()
  })

  it('detaches an attached tag and attaches an existing one from the visible vocabulary', async () => {
    const wrapper = await open()
    postJson.mockResolvedValue({ outcome: 'detached' })
    await wrapper.get('[data-attached-tags] button').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge-tags', { action: 'detach', personalSpaceId: 'space',
      personalProjectId: 'temporary-x', tagId: 't1', itemKind: 'entity', itemId: 'item-1' }, expect.objectContaining({ schema: expect.anything() }))
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/knowledge-tags')
      ? { candidates: [{ id: 't2', name: 'brevity', namespace: 'personal', status: 'active', match: 'exact' }] } : view())
    await wrapper.get('#tag-search').setValue('brevity')
    await flushPromises()
    expect(wrapper.find('[data-tag-create]').exists()).toBe(false)
    await wrapper.get('[data-tag-choice="t2"]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/knowledge-tags', expect.objectContaining({ action: 'attach', tagId: 't2' }), expect.objectContaining({ schema: expect.anything() }))
    wrapper.unmount()
  })

  it('shows the revival preview when creating a retired word would drop something, and attaches nothing', async () => {
    const wrapper = await open()
    getJson.mockImplementation(async (url: string) => url.startsWith('/api/knowledge-tags') ? { candidates: [] } : view())
    const retired = { id: 't9', name: '小说', namespace: 'personal', status: 'retired' }
    postJson.mockResolvedValue({ outcome: 'needs_person', tag: null, candidates: [], revival: {
      change: 'revive', tag: retired, other: null, status_after: 'active', new_tag_name: null, revives: false,
      links_moved: null, links_already_on_target: null, links_remaining: null, aliases: [], aliases_dropped: ['fiction'],
      relations_moved: 0, relations_dropped: [{ tag: retired, relation: 'parent',
        target: { id: 't1', name: '写作', namespace: 'personal', status: 'active' }, reason: 'cycle' }],
      undo: null, blocked: null, digest: 'f'.repeat(64) } })
    await wrapper.get('#tag-search').setValue('小说')
    await flushPromises()
    await wrapper.get('[data-tag-create]').trigger('click')
    await flushPromises()
    const box = wrapper.get('[data-tag-revival]')
    expect(box.text()).toContain('下面这些已不成立的部分会被去掉；现在还没有改动：')
    expect(box.text()).toContain('「小说」恢复为原来那个标签，不是新建。')
    expect(box.text()).toContain('「小说」与「写作」的上位关系会形成循环，不随它回来。')
    expect(box.text()).not.toContain('不转过去')
    expect(box.text()).toContain('fiction')
    expect(box.get('[data-tag-revival-confirm]').attributes('href')).toBe('/tags?tag=t9&change=revive')
    expect(postJson).toHaveBeenCalledTimes(1)
    expect(postJson).not.toHaveBeenCalledWith('/api/knowledge-tags', expect.objectContaining({ action: 'attach' }), expect.objectContaining({ schema: expect.anything() }))
    wrapper.unmount()
  })
})


it('explains a deleted source without rendering its IDs or offering source deletion again', async () => {
  const wrapper = await open(view({ evidence: [], evidence_count: 0, basis_review: 'changed',
    unavailable_sources: [{ episode_id: 'synthetic-removed-source', deletion_id: 'synthetic-deletion', status: 'unavailable' }] }))
  expect(wrapper.get('[data-unavailable-sources]').text()).toContain('1 段来源已彻底删除')
  expect(wrapper.find('[data-basis-review-card="changed"]').exists()).toBe(true)
  expect(wrapper.get('[data-item-sources]').text()).not.toContain('没有记录来源')
  expect(wrapper.text()).not.toContain('synthetic-removed-source')
  expect(wrapper.find('[data-source-delete-open="episode"]').exists()).toBe(false)
  wrapper.unmount()
})

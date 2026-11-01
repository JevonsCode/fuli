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
import { useConsoleStore } from '@/stores/console'
import SessionMigrationPage from './SessionMigrationPage.vue'

// rec#20 part 2: an Agent's link opens the session's batch migration.
function item(id: string, version = 0, overrides = {}) {
  return { item_kind: 'entity', item_id: id, version, title: id, content: `Synthetic held ${id}`, type: 'ProjectFact',
    category: 'fact', scope: { kind: 'temporary', projects: [{ id: 'temporary-x', temporary: true }], status: 'undetermined' },
    tags: [], confirmation_status: 'pending', content_source: 'agent_inferred', ...overrides }
}

const preview = (items: object[]) => ({ temporary_project_id: 'temporary-x', target_project: { id: 'alpha', name: 'Alpha' },
  held_count: items.length, linked_task_count: 1, items, next_offset: null })

async function open(path = '/s/session-1/migrate?client=codex&project=alpha') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/s/:sessionId/migrate', component: SessionMigrationPage },
    { path: '/s/:sessionId', component: { template: '<div />' } },
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: { template: '<div />' } },
    { path: '/knowledge/:scope/:spaceId/:mode/:itemKind/:itemId', component: { template: '<div />' } }] })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(SessionMigrationPage, { attachTo: document.body, global: { plugins: [pinia, router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  getJson.mockReset()
  postJson.mockReset()
})

describe('SessionMigrationPage', () => {
  it('lists exactly what the session holds, all chosen, and moves only what the person keeps checked', async () => {
    getJson.mockResolvedValueOnce(preview([item('a', 2), item('b', 0, { confirmation_status: 'confirmed',
      content_source: 'user_explicit' }), item('c')]))
      .mockResolvedValueOnce(preview([item('b', 0)]))
    postJson.mockResolvedValue({ target_project_id: 'alpha', moved: [{ item_kind: 'entity', item_id: 'a' },
      { item_kind: 'entity', item_id: 'c' }] })
    const wrapper = await open()
    expect(getJson).toHaveBeenCalledWith('/api/knowledge/session-migration?personalSpaceId=space&sessionId=session-1&client=codex&projectId=alpha&offset=0')
    const cards = wrapper.findAll('[data-migration-item]')
    expect(cards.map(card => card.text().split('\n')[0])).toHaveLength(3)
    expect(cards.every(card => card.attributes('data-chosen') === 'true')).toBe(true)
    expect(cards[0].classes()).toContain('shadow-md')
    expect(cards[0].text()).toContain('Agent 推断')
    expect(cards[0].text()).toContain('待确认')
    expect(wrapper.get('[data-migration-item="b"]').text()).toContain('你已确认')
    expect(wrapper.get('[data-migration-chosen]').text()).toBe('已选 3 / 3 条')
    // The person leaves b out.
    await wrapper.get('[data-migration-item="b"] [data-slot="checkbox"]').trigger('click')
    expect(wrapper.get('[data-migration-item="b"]').attributes('data-chosen')).toBe('false')
    expect(wrapper.get('[data-migration-item="b"]').classes()).not.toContain('shadow-md')
    expect(wrapper.get('[data-migration-confirm]').text()).toBe('迁入 2 条到「Alpha」')
    expect((wrapper.get('#migration-reason').element as HTMLInputElement).value).toBe('这个会话属于「Alpha」')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/knowledge/session-migration', { personalSpaceId: 'space',
      sourceApplication: 'codex', sessionId: 'session-1', projectId: 'alpha', reason: '这个会话属于「Alpha」',
      items: [{ itemKind: 'entity', itemId: 'a', expectedVersion: 2 }, { itemKind: 'entity', itemId: 'c', expectedVersion: 0 }] })
    expect(wrapper.get('[data-migration-notice]').text()).toBe('已把 2 条迁入「Alpha」，它们的确认状态没有变。')
    // What is left is what the person left out, still not chosen.
    expect(wrapper.findAll('[data-migration-item]').map(card => card.attributes('data-migration-item'))).toEqual(['b'])
    expect(wrapper.get('[data-migration-item="b"]').attributes('data-chosen')).toBe('false')
    expect(wrapper.get('[data-migration-confirm]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-migration-none] a').attributes('href')).toBe('/s/session-1?client=codex')
    wrapper.unmount()
  })

  it('a batch refused because an item changed moves nothing, re-reads and marks what changed', async () => {
    getJson.mockResolvedValueOnce(preview([item('a', 0), item('b', 0), item('c', 0)]))
      .mockResolvedValueOnce(preview([item('a', 1), item('b', 0)]))
    postJson.mockRejectedValueOnce(new ApiError('Conflict', 409, JSON.stringify({ code: 'stale_version' })))
    const wrapper = await open()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-migration-notice]').attributes('role')).toBe('alert')
    expect(wrapper.get('[data-migration-notice]').text()).toContain('这次一条都没有迁移')
    expect(wrapper.get('[data-migration-notice]').text()).toContain('1 条已经不在临时项目里')
    expect(wrapper.find('[data-migration-item="a"] [data-migration-changed]').exists()).toBe(true)
    expect(wrapper.find('[data-migration-item="b"] [data-migration-changed]').exists()).toBe(false)
    // The next confirm names the versions read now.
    postJson.mockResolvedValueOnce({ target_project_id: 'alpha', moved: [] })
    getJson.mockResolvedValueOnce(preview([]))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[1][1].items).toEqual([{ itemKind: 'entity', itemId: 'a', expectedVersion: 1 },
      { itemKind: 'entity', itemId: 'b', expectedVersion: 0 }])
    expect(wrapper.get('[data-migration-empty]').text()).toContain('不需要迁移')
    wrapper.unmount()
  })

  it('dot UI: when the re-read after a refusal fails it says so and sends nothing until a fresh read', async () => {
    getJson.mockResolvedValueOnce(preview([item('a', 0), item('b', 0)]))
      .mockRejectedValueOnce(new ApiError('Unavailable', 503, JSON.stringify({ error: 'provider down' })))
    postJson.mockRejectedValueOnce(new ApiError('Conflict', 409, JSON.stringify({ code: 'stale_version' })))
    const wrapper = await open()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    const notice = wrapper.get('[data-migration-notice]').text()
    expect(notice).toContain('这次一条都没有迁移')
    expect(notice).toContain('重新读取失败')
    expect(notice).not.toContain('已重新读取')
    expect(wrapper.get('[data-migration-confirm]').attributes('disabled')).toBeDefined()
    // dot P2 (210498d): the manual re-read recovers like the automatic one would have:
    // a changed, b left the temporary project, and the old failure is gone.
    getJson.mockResolvedValueOnce(preview([item('a', 1)]))
    await wrapper.get('[data-migration-reread]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-migration-item="a"] [data-migration-changed]').exists()).toBe(true)
    expect(wrapper.find('[data-migration-item="b"]').exists()).toBe(false)
    const recovered = wrapper.get('[data-migration-notice]').text()
    expect(recovered).not.toContain('重新读取失败')
    expect(recovered).toContain('已重新读取')
    expect(recovered).toContain('1 条已经不在临时项目里')
    expect(wrapper.get('[data-migration-confirm]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-migration-reread]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('dot P2-3: a further page lists more held items, unchosen, and any of them can be moved alone', async () => {
    const page = Array.from({ length: 100 }, (_, index) => item(`i${index}`))
    getJson.mockResolvedValueOnce({ ...preview(page), held_count: 101, next_offset: 100 })
      .mockResolvedValueOnce({ ...preview([item('i100', 3)]), held_count: 101, next_offset: null })
    postJson.mockResolvedValue({ target_project_id: 'alpha', moved: [{ item_kind: 'entity', item_id: 'i100' }] })
    const wrapper = await open()
    expect(wrapper.get('[data-migration-chosen]').text()).toBe('已选 100 / 101 条')
    await wrapper.get('[data-migration-more] button').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenLastCalledWith(expect.stringContaining('&offset=100'))
    expect(wrapper.get('[data-migration-item="i100"]').attributes('data-chosen')).toBe('false')
    expect(wrapper.find('[data-migration-more]').exists()).toBe(false)
    await wrapper.get('[data-migration-select-all]').trigger('click')
    expect(wrapper.get('[data-migration-too-many]').text()).toContain('一次最多迁移 100 条')
    expect(wrapper.get('[data-migration-confirm]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-migration-select-none]').trigger('click')
    await wrapper.get('[data-migration-item="i100"] [data-slot="checkbox"]').trigger('click')
    getJson.mockResolvedValueOnce({ ...preview(page), held_count: 100, next_offset: null })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(postJson.mock.calls[0][1].items).toEqual([{ itemKind: 'entity', itemId: 'i100', expectedVersion: 3 }])
    wrapper.unmount()
  })

  it('dot P2-1: an item the target already holds is marked and linked to where 加入项目 decides', async () => {
    getJson.mockResolvedValueOnce(preview([item('a'), item('b')])).mockResolvedValueOnce(preview([item('a'), item('b')]))
    postJson.mockRejectedValueOnce(new ApiError('Conflict', 409, JSON.stringify({ code: 'project_has_match',
      items: [{ item_kind: 'entity', item_id: 'b' }] })))
    const wrapper = await open()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-migration-notice]').text()).toContain('这次一条都没有迁移')
    expect(wrapper.find('[data-migration-item="b"] [data-migration-conflicted]').exists()).toBe(true)
    expect(wrapper.find('[data-migration-item="a"] [data-migration-conflicted]').exists()).toBe(false)
    expect(wrapper.get('[data-migration-conflicts] a').attributes('href')).toBe('/knowledge/personal/space/directory/entity/b')
    wrapper.unmount()
  })

  it('says when nothing waits, when the link is incomplete and when the read fails', async () => {
    getJson.mockResolvedValueOnce(preview([]))
    const empty = await open()
    expect(empty.find('[data-migration-empty]').exists()).toBe(true)
    expect(empty.find('form').exists()).toBe(false)
    empty.unmount()
    const incomplete = await open('/s/session-1/migrate?client=codex')
    expect(incomplete.get('[data-migration-link-missing]').text()).toContain('缺少')
    expect(getJson).toHaveBeenCalledTimes(1)
    incomplete.unmount()
    getJson.mockRejectedValueOnce(new ApiError('Bad request', 422, JSON.stringify({ error: 'migrate into a registered project' })))
    const failed = await open()
    expect(failed.get('[role="alert"]').text()).toContain('读不到本会话暂存的知识')
    failed.unmount()
  })
})

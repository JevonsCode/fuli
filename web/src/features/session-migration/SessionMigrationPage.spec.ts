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
  held_count: items.length, linked_task_count: 1, truncated: false, items })

async function open(path = '/s/session-1/migrate?client=codex&project=alpha') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/s/:sessionId/migrate', component: SessionMigrationPage },
    { path: '/s/:sessionId', component: { template: '<div />' } },
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: { template: '<div />' } }] })
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
    expect(getJson).toHaveBeenCalledWith('/api/knowledge/session-migration?personalSpaceId=space&sessionId=session-1&client=codex&projectId=alpha')
    const cards = wrapper.findAll('[data-migration-item]')
    expect(cards.map(card => card.text().split('\n')[0])).toHaveLength(3)
    expect(cards.every(card => card.attributes('data-chosen') === 'true')).toBe(true)
    expect(cards[0].classes()).toContain('shadow-md')
    expect(cards[0].text()).toContain('Agent 推断')
    expect(cards[0].text()).toContain('待确认')
    expect(cards[1].text()).toContain('你已确认')
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

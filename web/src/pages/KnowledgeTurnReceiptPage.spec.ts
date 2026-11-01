import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import { router as appRouter } from '@/router'
import KnowledgeTurnReceiptPage from './KnowledgeTurnReceiptPage.vue'

// rec#20: a receipt too long for the reply links here; every item is listed.
const entry = (index: number) => ({ item_kind: 'entity', item_id: `item-${index}`, version: 1, title: `Item ${index}`,
  content: `Synthetic content ${index}`, type: 'ProjectFact', category: 'fact', change: index % 2 ? 'updated' : 'created',
  scope: { kind: 'projects', projects: [{ id: 'alpha', name: 'Alpha' }], status: 'set' },
  weight: { percent: 10, basis: { confirmation_status: 'pending', confirmed_by_person: false, qualified_use_count: 0,
    distinct_task_count: 0, source_count: 1, negative_evidence_count: 0 } },
  tags: [], confirmation_status: 'pending', content_source: 'agent_inferred' })

describe('KnowledgeTurnReceiptPage', () => {
  it('lists every item the turn saved, each opening its own quick edit', async () => {
    getJson.mockResolvedValue({ entries: Array.from({ length: 12 }, (_, index) => entry(index)), unchanged_count: 2 })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/knowledge/turn/:spaceId', component: KnowledgeTurnReceiptPage },
      { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: { template: '<div />' } }] })
    await router.push('/knowledge/turn/space?episodes=e1,e2')
    await router.isReady()
    const wrapper = mount(KnowledgeTurnReceiptPage, { global: { plugins: [createPinia(), router] } })
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/knowledge/turn-receipt?personalSpaceId=space&episodes=e1%2Ce2', expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.findAll('[data-turn-entry]')).toHaveLength(12)
    expect(wrapper.get('[data-turn-count]').text()).toBe('共 12 条')
    expect(wrapper.get('[data-turn-entry="item-3"] a').attributes('href')).toBe('/knowledge/item/space/entity/item-3')
    expect(wrapper.get('[data-turn-entry="item-3"]').text()).toContain('更新')
    wrapper.unmount()
  })

  it('rec#5 C9: a turn whose knowledge the person permanently deleted says so, without its words', async () => {
    getJson.mockResolvedValue({ entries: [], unchanged_count: 0, deleted_count: 1 })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/knowledge/turn/:spaceId', component: KnowledgeTurnReceiptPage }] })
    await router.push('/knowledge/turn/space?episodes=e2')
    await router.isReady()
    const wrapper = mount(KnowledgeTurnReceiptPage, { global: { plugins: [createPinia(), router] } })
    await flushPromises()
    expect(wrapper.get('[data-turn-count]').text()).toBe('这一轮没有新增或更新的知识。')
    expect(wrapper.get('[data-turn-deleted]').text()).toBe('另有 1 条已彻底删除')
    wrapper.unmount()
  })

  it('receipt links resolve to their own pages, never to a knowledge workspace view', () => {
    expect(appRouter.resolve('/knowledge/item/space/entity/abc').name).toBe('knowledge-item-edit')
    expect(appRouter.resolve('/knowledge/item/space/relationship/abc').meta.layout).toBe('form')
    expect(appRouter.resolve('/knowledge/turn/space').name).toBe('knowledge-turn-receipt')
    expect(appRouter.resolve('/knowledge/personal/space/directory/entity/abc').name).toBe('knowledge-item')
    expect(appRouter.resolve('/knowledge/personal/space/project/directory').name).toBe('project-knowledge')
  })
})

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

const getJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), getJson }))

import { ApiError } from '@/api/client'
import { pageTitle } from '@/layouts/page-title'
import { router as appRouter } from '@/router'
import { useConsoleStore } from '@/stores/console'
import HabitDeliveryPage from './HabitDeliveryPage.vue'

// The 「FULI 习惯」 receipt line opens this list. Synthetic delivery record and habits only.
const KEY = '0123456789abcdef'
const habit = (id: string) => ({ item_kind: 'entity', item_id: id, version: 1, title: `Habit ${id}`, content: `Synthetic habit ${id}`,
  type: 'Preference', category: 'rule', scope: { kind: 'global', projects: [], status: 'set' }, weight: null, tags: [],
  confirmation_status: 'confirmed', content_source: 'user_explicit', evidence: [], evidence_count: 0, revisions: [] })
const delivery = { at: '2026-11-15T01:00:00.000Z', client: 'codex', model: null,
  items: [{ kind: 'entity', id: 'h-1' }, { kind: 'entity', id: 'h-2' }, { kind: 'entity', id: 'h-gone' }] }

function activeSpace() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConsoleStore().state = { mode: 'personal_only', activePersonalSpaceId: 'space', personalSpaces: [{ id: 'space', name: '我' }],
    personalProjects: [], projects: [], subscriptions: [] } as never
  return pinia
}

async function open(answer: (url: string) => unknown) {
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => answer(url))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/habits/:taskKey', component: HabitDeliveryPage },
    { path: '/knowledge/item/:spaceId/:itemKind/:itemId', component: { template: '<div />' } }] })
  await router.push(`/habits/${KEY}`)
  await router.isReady()
  const wrapper = mount(HabitDeliveryPage, { global: { plugins: [activeSpace(), router] } })
  await flushPromises()
  return wrapper
}

describe('HabitDeliveryPage', () => {
  it('lists each habit handed over with its quick edit, and one deleted since says so', async () => {
    const wrapper = await open((url) => {
      if (url === `/api/habit-deliveries/${KEY}`) return delivery
      if (url.includes('h-gone')) throw new ApiError('gone', 404)
      return habit(url.includes('h-1') ? 'h-1' : 'h-2')
    })
    expect(wrapper.findAll('[data-habit]')).toHaveLength(3)
    expect(pageTitle.value.text).toBe('这个对话一开始，FULI 交给助手的 3 条习惯')
    expect(wrapper.get('[data-habit="h-1"] a').attributes('href')).toBe('/knowledge/item/space/entity/h-1')
    expect(wrapper.get('[data-habit="h-1"] a').classes()).toContain('select-none')
    expect(wrapper.get('[data-habit="h-2"]').text()).toContain('Synthetic habit h-2')
    expect(wrapper.get('[data-habit="h-gone"] [data-habit-deleted]').text()).toBe('这条后来删掉了')
    expect(wrapper.get('[data-habit-footnote]').text()).toBe('助手有没有照做，看它的回复；FULI 只知道交给了它。')
    wrapper.unmount()
  })

  it('an expired or unknown record says so and reads no habit', async () => {
    const wrapper = await open(() => { throw new ApiError('missing', 404) })
    expect(wrapper.get('[data-habit-expired]').text()).toBe('这条记录已经过期或不存在。')
    expect(wrapper.findAll('[data-habit]')).toHaveLength(0)
    expect(getJson).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('the receipt link resolves to this page', () => {
    expect(appRouter.resolve(`/habits/${KEY}`).name).toBe('habit-delivery')
  })
})

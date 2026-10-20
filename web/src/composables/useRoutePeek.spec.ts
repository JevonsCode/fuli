import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useRoutePeek } from './useRoutePeek'

async function setup(...paths: string[]) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  for (const path of paths) await router.push(path)
  let peek!: ReturnType<typeof useRoutePeek>
  mount(defineComponent({ setup() { peek = useRoutePeek(); return () => h('div') } }), { global: { plugins: [router] } })
  return { router, peek: () => peek }
}

describe('useRoutePeek', () => {
  it('opens with a new history entry and closes by going back to the same collection', async () => {
    const { router, peek } = await setup('/collection?q=kept')
    peek().open({ spaceId: 'space-a', id: 'agent-1' })
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ q: 'kept', item: 'space-a/agent-1' })
    expect(peek().item.value).toEqual({ spaceId: 'space-a', id: 'agent-1' })
    peek().close()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collection?q=kept')
  })

  it('carries any characters in the space and the id through the URL', async () => {
    const { router, peek } = await setup('/collection')
    const item = { spaceId: 'space/a b', id: 'agent:ü/1?x' }
    peek().open(item)
    await flushPromises()
    expect(peek().item.value).toEqual(item)
    // A refresh reads the same item back from the URL.
    const reloaded = await setup(router.currentRoute.value.fullPath)
    expect(reloaded.peek().item.value).toEqual(item)
  })

  it('closes a quick look that arrived by a link without leaving the page', async () => {
    const { router, peek } = await setup('/collection?q=kept&item=space-a%2Fagent-2')
    expect(peek().item.value).toEqual({ spaceId: 'space-a', id: 'agent-2' })
    peek().close()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/collection?q=kept')
  })

  it('ignores an item that is not exactly one space and one id', async () => {
    for (const value of ['only-id', 'a/b/c', '/b', 'a/', '%E0%A4%A/x']) {
      const { peek } = await setup(`/collection?item=${encodeURIComponent(value)}`)
      expect(peek().item.value).toBeNull()
    }
  })
})

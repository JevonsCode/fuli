import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { useScrollRestoration } from './useScrollRestoration'

// A scroller whose height grows after it renders, as a lazily laid-out list does.
function growingScroller(start: number) {
  const element = document.createElement('div')
  let top = 0
  const limit = { max: start }
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value: number) => { top = Math.min(value, limit.max) } })
  return { element, limit }
}

describe('useScrollRestoration', () => {
  it('keeps applying the saved position while the content grows tall enough to reach it', async () => {
    const scroller = growingScroller(0)
    const page = defineComponent({
      setup() {
        const element = ref<HTMLElement | null>(scroller.element)
        useScrollRestoration(element, 'growing-list', ref(true))
        return () => h('div')
      },
    })
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/list', component: page },
      { path: '/detail', component: { render: () => h('div') } },
    ] })
    await router.push('/list')
    mount(RouterView, { global: { plugins: [router] } })
    await flushPromises()
    scroller.limit.max = 600
    scroller.element.scrollTop = 480
    await router.push('/detail')
    scroller.limit.max = 0
    scroller.element.scrollTop = 0
    await router.back()
    await flushPromises()
    expect(scroller.element.scrollTop).toBe(0)
    scroller.limit.max = 600
    await vi.waitFor(() => expect(scroller.element.scrollTop).toBe(480))
  })
})

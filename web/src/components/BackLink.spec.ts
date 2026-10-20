import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'
import BackLink from './BackLink.vue'

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

// Web history, since Back depends on the entry the collection left (history.state.back).
async function mountFromCollection(attrs: Record<string, string> = {}) {
  const router = createRouter({ history: createWebHistory(), routes: [
    { path: '/collection', component: { template: '<div />' } },
    { path: '/collection/:id', component: { template: '<div />' } },
  ] })
  await router.push('/collection?q=ada')
  await router.push('/collection/ada')
  const back = vi.spyOn(router, 'back')
  const push = vi.spyOn(router, 'push')
  const wrapper = mount(BackLink, {
    props: { to: '/collection', from: /^\/collection(\?|$)/ },
    attrs,
    slots: { default: 'Collection' },
    global: { plugins: [router] },
  })
  mounted.push(wrapper)
  return { wrapper, back, push }
}

describe('BackLink', () => {
  it('goes Back when the collection opened the page', async () => {
    const { wrapper, back, push } = await mountFromCollection()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    wrapper.get('a').element.dispatchEvent(event)
    await flushPromises()
    expect(back).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves a click with %s to the browser', async (_case, init) => {
    const { wrapper, back, push } = await mountFromCollection()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
    wrapper.get('a').element.dispatchEvent(event)
    await flushPromises()
    expect(back).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a link that opens in another tab to the browser', async () => {
    const { wrapper, back, push } = await mountFromCollection({ target: '_blank' })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    wrapper.get('a').element.dispatchEvent(event)
    await flushPromises()
    expect(back).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

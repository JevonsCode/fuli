import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory } from 'vue-router'
import Breadcrumb from './Breadcrumb.vue'

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

const parent = { label: 'Collection', to: '/collection', from: /^\/collection(\?|$)/ }

// Web history, since Back depends on the entry the collection left (history.state.back).
async function mountFromCollection(props: { current?: string } = {}) {
  const router = createRouter({ history: createWebHistory(), routes: [
    { path: '/collection', component: { template: '<div />' } },
    { path: '/collection/:id', component: { template: '<div />' } },
  ] })
  await router.push('/collection?q=ada')
  await router.push('/collection/ada')
  const back = vi.spyOn(router, 'back')
  const push = vi.spyOn(router, 'push')
  const wrapper = mount(Breadcrumb, { props: { parent, ...props }, global: { plugins: [router] }, attachTo: document.body })
  mounted.push(wrapper)
  return { wrapper, router, back, push }
}

function click(wrapper: Awaited<ReturnType<typeof mountFromCollection>>['wrapper'], init: MouseEventInit = {}) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  wrapper.get('[data-breadcrumb-parent]').element.dispatchEvent(event)
  return event
}

describe('Breadcrumb', () => {
  it('is a labelled nav with an ordered trail: a parent link, an icon separator and the current page', async () => {
    const { wrapper } = await mountFromCollection({ current: 'Ada' })
    const nav = wrapper.get('nav')
    expect(nav.attributes('aria-label')).toBe('页面位置')
    const items = nav.findAll('ol > li')
    expect(items).toHaveLength(2)
    expect(items[0]!.get('a').attributes('href')).toBe('/collection')
    expect(items[0]!.get('a').text()).toBe('Collection')
    expect(items[0]!.find('svg[aria-hidden="true"]').exists()).toBe(true)
    expect(items[1]!.attributes('aria-current')).toBe('page')
    expect(items[1]!.find('a').exists()).toBe(false)
    expect(items[1]!.text()).toBe('Ada')
    // No text glyph stands in for the separator or an arrow.
    expect(nav.text()).not.toMatch(/[←›>/]/)
  })

  it('leaves the current page out when the page names itself elsewhere', async () => {
    const { wrapper } = await mountFromCollection()
    expect(wrapper.findAll('ol > li')).toHaveLength(1)
    expect(wrapper.find('[aria-current="page"]').exists()).toBe(false)
  })

  it('goes Back when the parent opened the page', async () => {
    const { wrapper, back, push } = await mountFromCollection()
    const event = click(wrapper)
    await flushPromises()
    expect(back).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens the parent when something else opened the page', async () => {
    const router = createRouter({ history: createWebHistory(), routes: [
      { path: '/elsewhere', component: { template: '<div />' } },
      { path: '/collection', component: { template: '<div />' } },
      { path: '/collection/:id', component: { template: '<div />' } },
    ] })
    await router.push('/elsewhere')
    await router.push('/collection/ada')
    const back = vi.spyOn(router, 'back')
    const wrapper = mount(Breadcrumb, { props: { parent }, global: { plugins: [router] }, attachTo: document.body })
    mounted.push(wrapper)
    await wrapper.get('[data-breadcrumb-parent]').trigger('click', { button: 0 })
    await flushPromises()
    expect(back).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/collection')
  })

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Meta', { metaKey: true }],
    ['Shift', { shiftKey: true }],
    ['Alt', { altKey: true }],
    ['the middle button', { button: 1 }],
  ])('leaves a click with %s to the browser', async (_case, init) => {
    const { wrapper, back, push } = await mountFromCollection()
    const event = click(wrapper, init)
    await flushPromises()
    expect(back).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

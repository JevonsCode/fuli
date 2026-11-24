import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'

import { postJson } from '@/api/client'
import AdvancedOnly from './AdvancedOnly.vue'
import { adoptShownAreas, areaFor, delegationCategoryShown, hiddenAreas, reveal, shown, type AdvancedArea } from './advanced-areas'

const EVERY_AREA = ['roundtable', 'tonborg', 'tidy', 'lan'] as const

vi.mock('@/api/client', () => ({ getJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn(async () => ({ shown: [] })), deleteJson: vi.fn() }))

// Every link an Agent, a receipt or a bookmark can give into an area.
const LINKS: ReadonlyArray<[string, AdvancedArea]> = [
  ['/roundtables', 'roundtable'],
  ['/roundtables/thread-1', 'roundtable'],
  ['/roundtables/chat/chat-1', 'roundtable'],
  ['/visit-requests', 'lan'],
  ['/organize', 'tidy'],
  ['/settings?tab=connections#peer', 'lan'],
  ['/settings?setting=peer', 'lan'],
  ['/employees/tonborg?view=standards', 'tonborg'],
]

const at = (link: string) => {
  const url = new URL(link, 'http://console.test')
  return { path: url.pathname, query: Object.fromEntries(url.searchParams), hash: url.hash }
}

describe('advanced areas', () => {
  beforeEach(() => { vi.mocked(postJson).mockClear() })

  it.each(LINKS)('maps %s to %s', (link, area) => {
    expect(areaFor(at(link))).toBe(area)
  })

  it('maps nothing else to an area', () => {
    for (const link of ['/', '/inbox', '/settings', '/settings?tab=connections#ports', '/employees/tonborg', '/roundtablesx', '/organizer'])
      expect(areaFor(at(link))).toBeUndefined()
  })

  it('shows nothing before the first state read, and everything for a server that sends no record', () => {
    expect(EVERY_AREA.filter(shown)).toEqual([])
    adoptShownAreas(undefined)
    expect(EVERY_AREA.filter(shown)).toEqual([...EVERY_AREA])
    expect(hiddenAreas.value).toEqual([])
  })

  it('reveals at once, tells the server, and never takes an area back', () => {
    adoptShownAreas([])
    expect(delegationCategoryShown('lan_roundtable')).toBe(false)
    expect(delegationCategoryShown('settings')).toBe(true)
    reveal('lan')
    expect(shown('lan')).toBe(true)
    expect(delegationCategoryShown('lan_roundtable')).toBe(true)
    expect(postJson).toHaveBeenCalledWith('/api/advanced-areas/reveal', { id: 'lan', why: 'person' }, expect.anything())
    // A later state read that has not caught up yet does not hide it.
    adoptShownAreas([])
    expect(shown('lan')).toBe(true)
    expect(hiddenAreas.value).toEqual(['roundtable', 'tonborg', 'tidy'])
    reveal('lan')
    expect(postJson).toHaveBeenCalledTimes(1)
  })

  // Each link on a fresh console: the app's own router, stopped right after
  // its guards so no page loads.
  it.each(LINKS)('the router shows the area of %s before its page opens', async (link, area) => {
    vi.resetModules()
    const { router } = await import('@/router')
    const registry = await import('./advanced-areas')
    const { postJson: post } = await import('@/api/client')
    registry.adoptShownAreas([])
    const stop = router.beforeEach(() => false)
    await router.push(link)
    stop()
    expect(registry.shown(area)).toBe(true)
    expect(EVERY_AREA.filter(registry.shown)).toEqual([area])
    expect(post).toHaveBeenCalledWith('/api/advanced-areas/reveal', { id: area, why: 'link' }, expect.anything())
  })
})

describe('AdvancedOnly', () => {
  it('renders its content only while the area is shown, and adds it in place once shown', async () => {
    adoptShownAreas([])
    const Page = defineComponent({
      components: { AdvancedOnly },
      template: '<div><p data-before /><AdvancedOnly area="tidy"><section data-tidy /></AdvancedOnly><p data-after /></div>',
    })
    const wrapper = mount(Page, { attachTo: document.body })
    expect(wrapper.find('[data-tidy]').exists()).toBe(false)
    adoptShownAreas(['tidy'])
    await nextTick()
    expect([...wrapper.element.children].map(child => [...child.attributes].map(a => a.name)[0])).toEqual(['data-before', 'data-tidy', 'data-after'])
    wrapper.unmount()
  })
})

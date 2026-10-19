import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PreferenceDetail from './PreferenceDetail.vue'
import { knowledgeItemFromNode } from './model'
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('preference full-text disclosure', () => {
  it('coalesces resize notifications outside the observer delivery phase and cancels a pending frame on unmount', async () => {
    let notify!: ResizeObserverCallback
    let frame!: FrameRequestCallback
    const schedule = vi.fn((callback: FrameRequestCallback) => { frame = callback; return 17 })
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', schedule)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notify = callback } observe() {} disconnect() {} })
    const raw = { id: 'synthetic-resize', name: 'Synthetic', type: 'Preference', summary: 'Synthetic body', profile_aspect: 'taste' }
    const wrapper = mount(PreferenceDetail, { props: { item: knowledgeItemFromNode(raw), graph: { nodes: [raw], edges: [] } } })
    await flushPromises()
    const append = vi.spyOn(document.body, 'append')
    notify([], {} as ResizeObserver); notify([], {} as ResizeObserver)
    expect(append).not.toHaveBeenCalled()
    expect(schedule).toHaveBeenCalledTimes(1)
    frame(1); await flushPromises()
    expect(append).toHaveBeenCalledTimes(1)
    notify([], {} as ResizeObserver)
    wrapper.unmount()
    expect(cancel).toHaveBeenCalledWith(17)
  })
  it('does not oscillate when a clamped element reports its visible height during resize', async () => {
    let notify!: ResizeObserverCallback
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { notify = callback } observe() {} disconnect() {} })
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '10' } as CSSStyleDeclaration)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('is-preview') ? 80 : 90 })
    const raw = { id: 'synthetic-long', name: 'Synthetic long text', type: 'Preference', summary: 'Synthetic text\n'.repeat(9), profile_aspect: 'taste' }
    const wrapper = mount(PreferenceDetail, { props: { item: knowledgeItemFromNode(raw), graph: { nodes: [raw], edges: [] } } })
    await flushPromises()
    expect(wrapper.get('.preference-body').classes()).toContain('is-preview')
    notify([], {} as ResizeObserver); await flushPromises()
    expect(wrapper.get('.preference-body').classes()).toContain('is-preview')
    notify([], {} as ResizeObserver); await flushPromises()
    expect(wrapper.get('.preference-body').classes()).toContain('is-preview')
    await wrapper.findAll('button').find(b => b.text() === '展开全文')!.trigger('click')
    expect(wrapper.get('.preference-body').classes()).not.toContain('is-preview')
    wrapper.unmount()
  })
})

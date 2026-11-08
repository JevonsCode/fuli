import { h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import VirtualDirectoryList from './VirtualDirectoryList.vue'

const position = (wrapper: ReturnType<typeof mount>) => wrapper.get('.virtual-directory-list__position').text().split('/').map(part => part.trim()).join(' / ')
const items = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }))

describe('VirtualDirectoryList', () => {
  afterEach(() => { vi.useRealTimers() })

  it('virtualizes rows and keeps the scroll position in sync', async () => {
    const wrapper = mount(VirtualDirectoryList, {
      props: {
        items: Array.from({ length: 101 }, (_, index) => ({ id: index })),
        rowHeight: 68,
        label: '测试目录',
        resetKey: 'all',
      },
      slots: {
        header: () => h('div', { class: 'test-header' }, 'Header'),
        default: ({ index }: { index: number }) =>
          h('button', { class: 'test-row' }, `Row ${index + 1}`),
      },
    })

    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', {
      configurable: true,
      value: 136,
    })

    expect(wrapper.findAll('.test-row').length).toBeLessThan(101)
    expect(position(wrapper)).toBe('1 / 101')

    scroller.element.scrollTop = 68 * 50
    await scroller.trigger('scroll')

    expect(position(wrapper)).toBe('51 / 101')
    expect(wrapper.find('[data-virtual-index="50"]').exists()).toBe(true)

    await wrapper.setProps({ resetKey: 'filtered' })
    await flushPromises()

    expect(scroller.element.scrollTop).toBe(0)
    expect(position(wrapper)).toBe('1 / 101')
  })

  it('shows no position capsule while every row fits, and one once they overflow', async () => {
    const wrapper = mount(VirtualDirectoryList, {
      props: {
        items: [{ id: 0 }],
        rowHeight: 68,
        label: '测试目录',
        scrollsWith: 'page',
      },
      slots: {
        default: ({ index }: { index: number }) =>
          h('button', { class: 'test-row' }, `Row ${index + 1}`),
      },
    })
    await flushPromises()

    expect(wrapper.get('.virtual-directory-list').classes()).toContain('is-page-scroll')
    expect(wrapper.findAll('.test-row')).toHaveLength(1)
    expect(wrapper.find('.virtual-directory-list__position').exists()).toBe(false)

    await wrapper.setProps({ items: Array.from({ length: 20 }, (_, index) => ({ id: index })) })
    expect(position(wrapper)).toBe('1 / 20')
  })

  it('scrolls an active row into the virtual viewport', async () => {
    const wrapper = mount(VirtualDirectoryList, {
      props: {
        items: Array.from({ length: 101 }, (_, index) => ({ id: index })),
        rowHeight: 68,
        label: '测试目录',
        activeIndex: -1,
      },
      slots: {
        default: ({ index }: { index: number }) =>
          h('button', { class: 'test-row' }, `Row ${index + 1}`),
      },
    })
    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', {
      configurable: true,
      value: 136,
    })

    await wrapper.setProps({ activeIndex: 90 })
    await flushPromises()

    expect(wrapper.find('[data-virtual-index="90"]').exists()).toBe(true)
    expect(position(wrapper)).toBe('90 / 101')
  })

  it('keeps the capsule one width for any current number and groups thousands', async () => {
    const wrapper = mount(VirtualDirectoryList, {
      props: { items: items(1284), rowHeight: 68, label: '测试目录' },
      slots: { default: ({ index }: { index: number }) => h('div', `Row ${index}`) },
    })
    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', { configurable: true, value: 136 })
    const current = () => wrapper.get('.virtual-directory-list__current')

    // The current number reserves the room of the total written in full, so the capsule never resizes.
    expect(current().attributes('data-widest')).toBe('1,284')
    scroller.element.scrollTop = 68 * 1000
    await scroller.trigger('scroll')
    expect(position(wrapper)).toBe('1,001 / 1,284')
    expect(current().attributes('data-widest')).toBe('1,284')
  })

  it('shows the capsule while the list moves or is entered and fades it after, in opacity only', async () => {
    vi.useFakeTimers()
    const wrapper = mount(VirtualDirectoryList, {
      props: { items: items(101), rowHeight: 68, label: '测试目录' },
      slots: { default: ({ index }: { index: number }) => h('div', `Row ${index}`) },
    })
    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', { configurable: true, value: 136 })
    const capsule = () => wrapper.get('.virtual-directory-list__position')

    expect(capsule().classes()).not.toContain('is-awake')
    scroller.element.scrollTop = 68 * 10
    await scroller.trigger('scroll')
    expect(capsule().classes()).toContain('is-awake')
    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()
    expect(capsule().classes()).not.toContain('is-awake')

    await wrapper.trigger('pointerenter')
    expect(capsule().classes()).toContain('is-awake')
  })

  it('tells assistive technology the position only once scrolling settles', async () => {
    vi.useFakeTimers()
    const wrapper = mount(VirtualDirectoryList, {
      props: { items: items(101), rowHeight: 68, label: '测试目录' },
      slots: { default: ({ index }: { index: number }) => h('div', `Row ${index}`) },
    })
    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', { configurable: true, value: 136 })
    const status = () => wrapper.get('[role="status"]')

    // The glass is decoration; the one live region starts empty.
    expect(wrapper.get('.virtual-directory-list__position').attributes('aria-hidden')).toBe('true')
    expect(status().attributes('aria-live')).toBe('polite')
    expect(status().text()).toBe('')

    for (const row of [5, 20, 40]) {
      scroller.element.scrollTop = 68 * row
      await scroller.trigger('scroll')
      vi.advanceTimersByTime(100)
    }
    expect(status().text()).toBe('')

    vi.advanceTimersByTime(400)
    await wrapper.vm.$nextTick()
    expect(status().text()).toBe('第 41 条，共 101 条')
  })

  it('says when the drawn rows reach the last loaded one, so a paged list reads on', async () => {
    const wrapper = mount(VirtualDirectoryList, {
      props: { items: Array.from({ length: 200 }, (_, index) => ({ id: index })), rowHeight: 50, label: '测试目录' },
      slots: { default: ({ index }: { index: number }) => h('div', `Row ${index}`) },
    })
    const scroller = wrapper.get('.virtual-directory-list__scroller')
    Object.defineProperty(scroller.element, 'clientHeight', { configurable: true, value: 500 })
    expect(wrapper.emitted('nearEnd')).toBeUndefined()
    scroller.element.scrollTop = 50 * 190
    await scroller.trigger('scroll')
    expect(wrapper.emitted('nearEnd')).toHaveLength(1)
    // More rows arrive and the reader is still near the end: it asks again.
    await wrapper.setProps({ items: Array.from({ length: 205 }, (_, index) => ({ id: index })) })
    expect(wrapper.emitted('nearEnd')).toHaveLength(2)
  })
})

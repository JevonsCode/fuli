import { h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import VirtualDirectoryList from './VirtualDirectoryList.vue'

describe('VirtualDirectoryList', () => {
  it('virtualizes rows and keeps the watermark and scroll position in sync', async () => {
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
    expect(wrapper.get('.virtual-directory-list__watermark').text()).toBe('#001')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 101')

    scroller.element.scrollTop = 68 * 50
    await scroller.trigger('scroll')

    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('051/ 101')
    expect(wrapper.find('[data-virtual-index="50"]').exists()).toBe(true)

    await wrapper.setProps({ resetKey: 'filtered' })
    await flushPromises()

    expect(scroller.element.scrollTop).toBe(0)
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 101')
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
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('090/ 101')
  })
})

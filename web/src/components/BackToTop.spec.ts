import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BackToTop from './BackToTop.vue'

describe('BackToTop', () => {
  it('appears only after scrolling past the threshold and jumps back to the start', async () => {
    const scroller = document.createElement('div')
    const wrapper = mount(BackToTop, { props: { scroller, threshold: 600 } })
    expect(wrapper.find('[data-back-to-top]').exists()).toBe(false)

    scroller.scrollTop = 900
    scroller.dispatchEvent(new Event('scroll'))
    await wrapper.vm.$nextTick()
    const button = wrapper.get('[data-back-to-top]')
    // Icon only: the words live in the accessible name, not on the button face.
    expect(button.text()).toBe('')
    expect(button.attributes('aria-label')).toMatch(/回到顶部|Back to top/)

    await button.trigger('click')
    expect(scroller.scrollTop).toBe(0)
    expect(wrapper.find('[data-back-to-top]').exists()).toBe(false)
    wrapper.unmount()
  })
})
